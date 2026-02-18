// src/systems/HowlerAudioSystem.ts
// ============================================================
// THE STILL — HowlerAudioSystem (Playback-first)
// ------------------------------------------------------------
// Responsibilities:
//  - Reliable playback for SFX + Ambient (later: music playback too)
//  - Listens to "audio:unlock-request" to unlock mobile audio
//  - Listens to UI SFX events for hover/click
//  - Owns its own cache + unload/dispose
//
// Notes:
//  - Does NOT replace existing AudioSystem analysis.
//  - Avoids emitting "audio:*" events to prevent conflicts.
// ============================================================

import { Howl, Howler } from "howler";
import type { EventBus } from "../core/EventBus";

export type HowlerBusName = "master" | "sfx" | "ambient" | "music";

export type HowlerAudioState = {
  isUnlocked: boolean;
  isMuted: boolean;
  master: number; // 0..1
  sfx: number; // 0..1
  ambient: number; // 0..1
  music: number; // 0..1
};

export interface HowlerAudioSystemDeps {
  bus: EventBus;
  basePath?: string; // default "/assets/audio"
  startMuted?: boolean;
  volumes?: Partial<Pick<HowlerAudioState, "master" | "sfx" | "ambient" | "music">>;
}

// Allow extra fields without caring (source, etc.)
type UiSfxPayload = { kind?: "hover" | "click"; source?: string; [k: string]: unknown };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

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

  // De-dupe guard (protects you if both old and new UI events are emitted)
  private lastHoverAt = 0;
  private lastClickAt = 0;
  private readonly dedupeWindowMs = 25;

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

  toggleMute(): void {
    this.state.isMuted = !this.state.isMuted;
    Howler.mute(this.state.isMuted);
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

    this.bus.emit("howler:unlocked", {});
    this.emitState("howler:unlocked");
  };

  // ---------------------------------------------------------------------------
  // UI sounds
  // ---------------------------------------------------------------------------

  private onUiHover = (_p?: UiSfxPayload): void => {
    const now = performance.now();
    if (now - this.lastHoverAt < this.dedupeWindowMs) return;
    this.lastHoverAt = now;

    const url = `${this.basePath}/ui/hover.mp3`;
    this.playSfx(this.UI_HOVER_ID, url, this.state.sfx);
  };

  private onUiClick = (_p?: UiSfxPayload): void => {
    const now = performance.now();
    if (now - this.lastClickAt < this.dedupeWindowMs) return;
    this.lastClickAt = now;

    const url = `${this.basePath}/ui/click.mp3`;
    this.playSfx(this.UI_CLICK_ID, url, this.state.sfx);
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
