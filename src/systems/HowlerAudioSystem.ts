// src/systems/HowlerAudioSystem.ts
// ============================================================
// THE STILL — HowlerAudioSystem (Playback-first)
// ------------------------------------------------------------
// Responsibilities:
//  - Reliable playback for SFX + Ambient (later: music playback too)
//  - Listens to "audio:unlock-request" to unlock mobile audio
//  - Listens to UI SFX events for hover/click
//  - Listens to "howler:ambient:set" to start/stop ambient loops
//  - Owns its own cache + unload/dispose
//
// Notes:
//  - Does NOT replace existing AudioSystem analysis.
//  - Avoids emitting "audio:*" events to prevent conflicts.
// ============================================================

import { Howl, Howler } from "howler";
import type { EventBus } from "../core/EventBus";

export type HowlerBusName = "master" | "sfx" | "ambient" | "music";

// ✅ Added ui lane (for hover/click only)
export type HowlerAudioState = {
  isUnlocked: boolean;
  isMuted: boolean;
  master: number; // 0..1
  sfx: number; // 0..1
  ambient: number; // 0..1
  music: number; // 0..1
  ui: number; // 0..1  ✅ UI hover/click lane
};

export interface HowlerAudioSystemDeps {
  bus: EventBus;
  basePath?: string; // default "/assets/audio"
  startMuted?: boolean;
  // ✅ Added ui volume pick
  volumes?: Partial<Pick<HowlerAudioState, "master" | "sfx" | "ambient" | "music" | "ui">>;
}

// Allow extra fields without caring (source, etc.)
type UiSfxPayload = { kind?: "hover" | "click"; source?: string; [k: string]: unknown };

type HowlerAmbientSetPayload = {
  id: string;
  url: string;
  enabled: boolean;
  // future: per-ambient volume overrides, fades, categories, etc.
  volume01?: number;
  [k: string]: unknown;
};

// ✅ Volume sliders (future Harmony UI will emit this)
type HowlerVolumeSetPayload = {
  bus: HowlerBusName | "ui";
  value01?: number; // some emitters use value01
  volume01?: number; // some emitters use volume01
  value?: number; // fallback (rare)
  source?: string;
  [k: string]: unknown;
};

// ✅ UI bleeps enable/disable (keeps wiring, silences UI only)
type HowlerUiSfxEnabledPayload = {
  enabled: boolean;
  source?: string;
  [k: string]: unknown;
};

// ✅ Convenience: set UI bleep volume directly
type HowlerUiSfxVolumePayload = {
  value01?: number;
  volume01?: number;
  value?: number;
  source?: string;
  [k: string]: unknown;
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const toFinite01 = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return clamp01(fallback);
  return clamp01(n);
};

const pickVolume01 = (p: unknown, fallback: number): number => {
  if (!p || typeof p !== "object") return clamp01(fallback);
  const r = p as Record<string, unknown>;
  // Accept multiple naming conventions
  return toFinite01(r.value01 ?? r.volume01 ?? r.value, fallback);
};

/**
 * Tiny silent WAV (gesture unlock helper for iOS/Safari).
 * Played at volume 0 then stopped/unloaded.
 */
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRggHAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YeQGAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type HowlerGlobalWithEvents = typeof Howler & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on?: (event: string, fn: (...args: any[]) => void, id?: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off?: (event: string, fn?: (...args: any[]) => void, id?: any) => void;
};

export class HowlerAudioSystem {
  private readonly bus: EventBus;
  private readonly basePath: string;

  private state: HowlerAudioState;

  /**
   * Cache of Howl instances.
   * Keyed by a stable "cache id" so URL collisions can't happen.
   */
  private howls = new Map<string, Howl>();

  private unlockAttempted = false;

  private readonly UI_HOVER_ID = "ui:hover";
  private readonly UI_CLICK_ID = "ui:click";

  // ✅ UI SFX master enable (lets us keep wiring, but silence UI bleeps)
  // Default ON so you get immediate feedback once audio is unlocked.
  private uiSfxEnabled = true;

  // De-dupe guard (protects you if both old and new UI events are emitted)
  private lastHoverAt = 0;
  private lastClickAt = 0;
  private readonly dedupeWindowMs = 25;

  // Ambient loop desired state (lets us enable before unlock, then reconcile later)
  private ambientDesired = new Map<string, { url: string; enabled: boolean; volume01?: number }>();

  // Ambient loop active instances (dedupe + clean stops)
  private ambientActive = new Map<string, { cacheId: string; howl: Howl }>();

  // Stored refs so dispose() can truly unsubscribe (HMR-safe)
  private readonly onHowlerMute?: (muted: boolean) => void;
  private readonly onHowlerVolume?: (v: number) => void;

  constructor(deps: HowlerAudioSystemDeps) {
    this.bus = deps.bus;
    this.basePath = (deps.basePath ?? "/assets/audio").replace(/\/+$/, "");

    const startMuted = Boolean(deps.startMuted);

    this.state = {
      isUnlocked: false,
      isMuted: startMuted,
      master: clamp01(deps.volumes?.master ?? 1.0),
      sfx: clamp01(deps.volumes?.sfx ?? 0.85),
      ambient: clamp01(deps.volumes?.ambient ?? 0.7),
      music: clamp01(deps.volumes?.music ?? 1.0),
      ui: clamp01(deps.volumes?.ui ?? 0.6), // ✅ default UI bleep level
    };

    Howler.volume(this.state.master);
    Howler.mute(this.state.isMuted);

    // Reuse the Engine's existing unlock flow:
    // Engine already emits "audio:unlock-request" on first user gesture.
    this.bus.on("audio:unlock-request", this.onUnlockRequest);

    // ✅ Canonical Harmony UI SFX events
    this.bus.on<UiSfxPayload>("ui:sfx:hover", this.onUiHover);
    this.bus.on<UiSfxPayload>("ui:sfx:click", this.onUiClick);

    // ✅ Back-compat (optional): keep if other UI emits old names
    this.bus.on<UiSfxPayload>("ui:hover", this.onUiHover);
    this.bus.on<UiSfxPayload>("ui:click", this.onUiClick);

    // ✅ Ambient loop commands (from HarmonyAmbientSystem)
    this.bus.on<HowlerAmbientSetPayload>("howler:ambient:set", this.onAmbientSet);

    // ✅ Volume sliders (Harmony UI / System)
    this.bus.on<HowlerVolumeSetPayload>("howler:volume:set", this.onVolumeSet);

    // ✅ UI bleeps: enable/disable + volume
    this.bus.on<HowlerUiSfxEnabledPayload>("howler:ui-sfx:set-enabled", this.onUiSfxSetEnabled);
    this.bus.on<HowlerUiSfxVolumePayload>("howler:ui-sfx:set-volume", this.onUiSfxSetVolume);

    // Optional: listen for global Howler changes IF supported (guarded).
    const H = Howler as HowlerGlobalWithEvents;

    if (typeof H.on === "function") {
      this.onHowlerMute = (muted: boolean) => {
        this.state.isMuted = Boolean(muted);
        this.emitState("howler:mute");
      };

      this.onHowlerVolume = (v: number) => {
        this.state.master = clamp01(v);
        this.emitState("howler:volume");
      };

      try {
        H.on("mute", this.onHowlerMute);
        H.on("volume", this.onHowlerVolume);
      } catch {
        // If a given build throws, we simply skip global sync.
      }
    }
  }

  update(_dt: number): void {
    // No per-frame work needed (yet).
  }

  getState(): HowlerAudioState {
    return { ...this.state };
  }

  // ✅ Public toggle for UI bleeps only (keeps other SFX channels free for future)
  setUiSfxEnabled(enabled: boolean): void {
    this.uiSfxEnabled = Boolean(enabled);
  }

  // ✅ Dedicated UI volume lane (hover/click only)
  setUiVolume(value01: number): void {
    this.state.ui = clamp01(value01);
    this.emitState("howler:set-ui");
  }

  toggleMute(): void {
    this.state.isMuted = !this.state.isMuted;
    Howler.mute(this.state.isMuted);

    // Keep CPU clean: stop active ambients when muting.
    if (this.state.isMuted) {
      for (const id of Array.from(this.ambientActive.keys())) this.stopAmbient(id);
    } else {
      // When unmuting, reconcile any desired ambients.
      this.reconcileAllDesiredAmbients();
    }

    this.emitState("howler:toggle-mute");
  }

  setMasterVolume(value01: number): void {
    this.state.master = clamp01(value01);
    Howler.volume(this.state.master);
    this.emitState("howler:set-master");
  }

  setSfxVolume(value01: number): void {
    this.state.sfx = clamp01(value01);
    this.emitState("howler:set-sfx");
  }

  setAmbientVolume(value01: number): void {
    this.state.ambient = clamp01(value01);
    this.emitState("howler:set-ambient");

    // Apply new volume to active ambients.
    // If a specific ambient has an override volume01, we respect it.
    for (const [id, a] of this.ambientActive.entries()) {
      const desired = this.ambientDesired.get(id);
      const baseVol = typeof desired?.volume01 === "number" ? desired.volume01 : this.state.ambient;

      try {
        a.howl.volume(clamp01(baseVol));
      } catch {
        // ignore
      }
    }
  }

  setMusicVolume(value01: number): void {
    this.state.music = clamp01(value01);
    this.emitState("howler:set-music");
  }

  dispose(): void {
    this.bus.off("audio:unlock-request", this.onUnlockRequest);

    // ✅ Canonical offs
    this.bus.off("ui:sfx:hover", this.onUiHover);
    this.bus.off("ui:sfx:click", this.onUiClick);

    // ✅ Back-compat offs
    this.bus.off("ui:hover", this.onUiHover);
    this.bus.off("ui:click", this.onUiClick);

    // ✅ Ambient off
    this.bus.off("howler:ambient:set", this.onAmbientSet);

    // ✅ Volume slider offs
    this.bus.off("howler:volume:set", this.onVolumeSet);

    // ✅ UI bleeps offs
    this.bus.off("howler:ui-sfx:set-enabled", this.onUiSfxSetEnabled);
    this.bus.off("howler:ui-sfx:set-volume", this.onUiSfxSetVolume);

    // Stop any active ambients first (so they don't keep playing if cached)
    for (const id of Array.from(this.ambientActive.keys())) this.stopAmbient(id);
    this.ambientDesired.clear();

    // Cleanly remove global listeners if they were attached.
    const H = Howler as HowlerGlobalWithEvents;
    if (typeof H.off === "function") {
      try {
        if (this.onHowlerMute) H.off("mute", this.onHowlerMute);
        if (this.onHowlerVolume) H.off("volume", this.onHowlerVolume);
      } catch {
        // ignore
      }
    }

    for (const howl of this.howls.values()) {
      try {
        howl.stop();
        howl.unload();
      } catch {
        // ignore
      }
    }
    this.howls.clear();
  }

  // ---------------------------------------------------------------------------
  // Unlock
  // ---------------------------------------------------------------------------

  private onUnlockRequest = (payload?: { source?: string } | undefined): void => {
    // If something emits unlock from hover, ignore it.
    const src = String(payload?.source ?? "");
    const isHoverBased = src.includes("hover");

    if (isHoverBased) return; // keep waiting for a real gesture
    if (this.unlockAttempted) return;

    this.unlockAttempted = true;

    // Resume Howler's AudioContext if available (must be gesture-bound)
    const ctx = Howler.ctx;
    if (ctx && ctx.state !== "running") {
      ctx.resume().catch(() => {
        // swallow
      });
    }

    // Gesture-bound silent play helps unlock iOS/Safari
    try {
      const unlockHowl = new Howl({
        src: [SILENT_WAV_DATA_URL],
        volume: 0.0,
        preload: true,
        html5: false,
      });
      const id = unlockHowl.play();
      unlockHowl.stop(id);
      unlockHowl.unload();
    } catch {
      // ignore
    }

    this.state.isUnlocked = true;

    // Start any ambients that were enabled before unlock.
    this.reconcileAllDesiredAmbients();

    this.bus.emit("howler:unlocked", {});
    this.emitState("howler:unlocked");
  };

  // ---------------------------------------------------------------------------
  // Volume sliders (Harmony UI)
  // ---------------------------------------------------------------------------

  private onVolumeSet = (p: HowlerVolumeSetPayload): void => {
    const busName = String(p?.bus ?? "").trim() as HowlerBusName | "ui";
    const v = pickVolume01(p, 1.0);

    switch (busName) {
      case "master":
        this.setMasterVolume(v);
        break;
      case "sfx":
        this.setSfxVolume(v);
        break;
      case "ambient":
        this.setAmbientVolume(v);
        break;
      case "music":
        this.setMusicVolume(v);
        break;
      case "ui":
        this.setUiVolume(v);
        break;
      default:
        // ignore unknown bus
        break;
    }
  };

  private onUiSfxSetEnabled = (p: HowlerUiSfxEnabledPayload): void => {
    this.setUiSfxEnabled(Boolean(p?.enabled));
    this.emitState("howler:ui-sfx:set-enabled");
  };

  private onUiSfxSetVolume = (p: HowlerUiSfxVolumePayload): void => {
    const v = pickVolume01(p, this.state.ui);
    this.setUiVolume(v);
    this.emitState("howler:ui-sfx:set-volume");
  };

  // ---------------------------------------------------------------------------
  // UI sounds
  // ---------------------------------------------------------------------------

  private onUiHover = (_p?: UiSfxPayload): void => {
    if (!this.uiSfxEnabled) return;

    const now = performance.now();
    if (now - this.lastHoverAt < this.dedupeWindowMs) return;
    this.lastHoverAt = now;

    const url = `${this.basePath}/ui/hover.mp3`;
    this.playSfx(this.UI_HOVER_ID, url, this.state.ui); // ✅ UI lane
  };

  private onUiClick = (_p?: UiSfxPayload): void => {
    if (!this.uiSfxEnabled) return;

    const now = performance.now();
    if (now - this.lastClickAt < this.dedupeWindowMs) return;
    this.lastClickAt = now;

    const url = `${this.basePath}/ui/click.mp3`;
    this.playSfx(this.UI_CLICK_ID, url, this.state.ui); // ✅ UI lane
  };

  private playSfx(eventId: string, url: string, volume01: number): void {
    if (this.state.isMuted) return;
    if (!this.state.isUnlocked) return;

    const vol = clamp01(volume01);

    // Key the cache by event + url so changes can never collide.
    const cacheId = `sfx:${eventId}:${url}`;

    const howl = this.getOrCreateHowl(cacheId, url, { loop: false, volume: vol });
    howl.volume(vol);
    howl.play();
  }

  // ---------------------------------------------------------------------------
  // Ambient loops
  // ---------------------------------------------------------------------------

  private onAmbientSet = (p: HowlerAmbientSetPayload): void => {
    const id = String(p?.id ?? "").trim();
    const url = String(p?.url ?? "").trim();
    const enabled = Boolean(p?.enabled);

    if (!id || !url) return;

    // Remember intent even if we're locked/muted so we can reconcile later.
    this.ambientDesired.set(id, { url, enabled, volume01: typeof p.volume01 === "number" ? p.volume01 : undefined });

    // Apply immediately if possible.
    this.applyAmbientDesired(id);
  };

  private reconcileAllDesiredAmbients(): void {
    for (const id of this.ambientDesired.keys()) {
      this.applyAmbientDesired(id);
    }
  }

  private applyAmbientDesired(id: string): void {
    const desired = this.ambientDesired.get(id);
    if (!desired) return;

    // If disabled, always stop immediately (even if locked/muted).
    if (!desired.enabled) {
      this.stopAmbient(id);
      return;
    }

    // Enabled: only start if audio can actually play.
    if (this.state.isMuted) return;
    if (!this.state.isUnlocked) return;

    this.startAmbient(id, desired.url, desired.volume01);
  }

  private startAmbient(id: string, url: string, volume01?: number): void {
    // Dedupe: if already active with same url, do nothing.
    const nextCacheId = `ambient:${id}:${url}`;
    const active = this.ambientActive.get(id);
    if (active) {
      if (active.cacheId === nextCacheId) return;
      // If url changed, stop old then start new.
      this.stopAmbient(id);
    }

    const baseVol = this.state.ambient;
    const vol = clamp01(typeof volume01 === "number" ? volume01 : baseVol);

    const howl = this.getOrCreateHowl(nextCacheId, url, { loop: true, volume: vol });

    // Ensure current volume is correct.
    howl.volume(vol);

    // Play the loop.
    howl.play();

    this.ambientActive.set(id, { cacheId: nextCacheId, howl });
  }

  private stopAmbient(id: string): void {
    const active = this.ambientActive.get(id);
    if (!active) return;

    try {
      // Stop all instances (safe even if multiple play calls occurred)
      active.howl.stop();
    } catch {
      // ignore
    }

    this.ambientActive.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Howl cache
  // ---------------------------------------------------------------------------

  private getOrCreateHowl(cacheId: string, url: string, opts: { loop: boolean; volume: number }): Howl {
    const existing = this.howls.get(cacheId);
    if (existing) return existing;

    const howl = new Howl({
      src: [url],
      loop: opts.loop,
      volume: clamp01(opts.volume),
      preload: true,
      html5: false,
    });

    this.howls.set(cacheId, howl);
    return howl;
  }

  // ---------------------------------------------------------------------------
  // Bus helpers
  // ---------------------------------------------------------------------------

  private emitState(reason: string): void {
    this.bus.emit("howler:state", { state: this.getState(), reason });
  }
}