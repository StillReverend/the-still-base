// src/systems/harmony/HarmonySystem.ts
// ============================================================
// THE STILL — HarmonySystem
//  - Owns Harmony UI state
//  - Talks only through EventBus (no AudioSystem imports)
//  - Mirrors canonical environment snapshots from HarmonyEnvironmentSystem
//  - Enforces Director vs Lumen capability + unlock gating (authoritative)
//
// MVP (Mar 2026):
//  - KEEP: Ritual, Presets, Filters, Particles, Ambient, Audio Sliders
//  - REMOVE: Spectrum/Colors + Lumen settings group plumbing
//    (no env.colors capability, no unlocks.colors, no selectColor UI handler)
// ============================================================

import type { EventBus } from "../../core/EventBus";
import { HarmonyUI } from "./HarmonyUI";
import { HARMONY_DEFAULT_STATE, type HarmonyState, type AudioStateEvent } from "./types";
import type { RepeatMode } from "../PersistenceSystem";
import { getTrackMeta } from "./TrackCatalog";

type AnyFn = (...args: any[]) => void;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const toNum = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const to01 = (v: unknown, fallback: number): number => clamp01(toNum(v, fallback));

type AudioSnapshot = {
  playing: boolean;
  trackId: string | null;
  title: string;
  positionSec: number;
  durationSec: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
};

const isRepeatMode = (v: unknown): v is RepeatMode => v === "off" || v === "one" || v === "all";

// Canonical environment snapshot shape (kept local to avoid importing Persistence types here)
type HarmonyEnvironmentSnapshot = {
  filterId?: string;
  particles?: Record<string, boolean>;
  ambients?: Record<string, boolean>;
};

// EnvironmentSystem emits a richer payload; we accept multiple aliases safely.
type HarmonyEnvironmentStateEvent = {
  environment?: HarmonyEnvironmentSnapshot;
  state?: HarmonyEnvironmentSnapshot;

  // allow optional aliases (we ignore colorId in MVP)
  colorId?: string;
  filterId?: string;
  particles?: Record<string, boolean>;
  ambients?: Record<string, boolean>;

  reason?: string;
};

const safeString = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v : fallback);

const safeBoolMap = (v: unknown): Record<string, boolean> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || !k) continue;
    out[k] = Boolean(val);
  }
  return out;
};

const shallowBoolMapEquals = (a: Record<string, boolean>, b: Record<string, boolean>): boolean => {
  if (a === b) return true;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};

// ------------------------------------------------------------
// Director vs Lumen policy + capability/unlock helpers
// ------------------------------------------------------------

type HarmonyUiMode = "cinematic" | "minimal" | "full";
type HarmonyOwner = "director" | "lumen" | string;

type HarmonyCapabilityKey =
  | "playback.basic"
  | "playback.transport"
  | "playback.shuffle"
  | "playback.repeat"
  | "env.panel"
  | "env.filters"
  | "env.particles"
  | "env.ambients"
  | "env.presets"
  | "mix.lanes"
  | "ui.hide";

type HarmonyCapabilitiesMap = Partial<Record<HarmonyCapabilityKey, boolean>>;

type HarmonyUnlocksShape = Partial<{
  filters: Record<string, boolean>;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
  presets: Record<string, boolean>;
}>;

const readOwner = (state: HarmonyState): HarmonyOwner => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = (state as any)?.owner;
  return typeof o === "string" && o.trim() ? o.trim() : "lumen";
};

const readUiMode = (state: HarmonyState): HarmonyUiMode => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = String((state as any)?.uiMode ?? "full").toLowerCase();
  return m === "cinematic" || m === "minimal" || m === "full" ? (m as HarmonyUiMode) : "full";
};

const readCaps = (state: HarmonyState): HarmonyCapabilitiesMap => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (state as any)?.capabilities;
  return c && typeof c === "object" ? (c as HarmonyCapabilitiesMap) : {};
};

const capEnabled = (caps: HarmonyCapabilitiesMap, key: HarmonyCapabilityKey, fallback = true): boolean => {
  const v = caps[key];
  return typeof v === "boolean" ? v : fallback;
};

const readUnlocks = (state: HarmonyState): HarmonyUnlocksShape => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = (state as any)?.unlocks;
  return u && typeof u === "object" ? (u as HarmonyUnlocksShape) : {};
};

const isUnlocked = (owner: HarmonyOwner, unlocks: HarmonyUnlocksShape, kind: string, id: string): boolean => {
  // Director path is authored; unlock gating is a lumen rule.
  if (String(owner).toLowerCase() === "director") return true;

  const map =
    kind === "filter"
      ? unlocks.filters
      : kind === "particle"
        ? unlocks.particles
        : kind === "ambient"
          ? unlocks.ambients
          : kind === "preset"
            ? unlocks.presets
            : undefined;

  // If unlock maps are missing, default permissive.
  if (!map) return true;
  return Boolean(map[id]);
};

// ------------------------------------------------------------
// ✅ Keep UI responsive: mirror the particle radio-group immediately
// (EnvironmentSystem is authoritative; this prevents multi-on flashes.)
// ------------------------------------------------------------
const applyParticleRadioLocal = (prev: Record<string, boolean>, id: string, enabled: boolean): Record<string, boolean> => {
  const base = { ...(prev ?? {}) };

  const keys = new Set<string>([...Object.keys(base), id]);

  if (!enabled) {
    const out: Record<string, boolean> = {};
    for (const k of keys) out[k] = false;
    return out;
  }

  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = k === id;
  return out;
};

const makeDefaultState = (): HarmonyState => {
  // Important: avoid sharing nested object references if defaults are reused.
  return {
    ...HARMONY_DEFAULT_STATE,
    particles: { ...(HARMONY_DEFAULT_STATE.particles ?? {}) },
    ambients: { ...(HARMONY_DEFAULT_STATE.ambients ?? {}) },
    mix: { ...(HARMONY_DEFAULT_STATE.mix ?? { master: 1, music: 1, sfx: 1, ambient: 1, ui: 1 }) },
    capabilities: { ...(HARMONY_DEFAULT_STATE.capabilities ?? {}) },
    unlocks: {
      ...(HARMONY_DEFAULT_STATE.unlocks ?? { filters: {}, particles: {}, ambients: {}, presets: {} }),
      filters: { ...(HARMONY_DEFAULT_STATE.unlocks?.filters ?? {}) },
      particles: { ...(HARMONY_DEFAULT_STATE.unlocks?.particles ?? {}) },
      ambients: { ...(HARMONY_DEFAULT_STATE.unlocks?.ambients ?? {}) },
      presets: { ...(HARMONY_DEFAULT_STATE.unlocks?.presets ?? {}) },
    },
  } as HarmonyState;
};

class HarmonySystem {
  private bus: EventBus;
  private ui: HarmonyUI | null = null;
  private state: HarmonyState = makeDefaultState();
  private disposers: Array<() => void> = [];

  private renderRaf = 0;
  private renderQueued = false;

  private lastAudioApplied: AudioSnapshot | null = null;

  // Track last environment snapshot applied to avoid redundant renders
  private lastEnvApplied: {
    filterId: string;
    particles: Record<string, boolean>;
    ambients: Record<string, boolean>;
  } | null = null;

  // Avoid spamming AudioSystem when sliders move rapidly
  private musicMixRaf = 0;
  private musicMixPending: number | null = null;
  private lastMusicMixSent: number | null = null;

  // Howler state boot sync: accept master/music only once (initial),
  // then treat Harmony as canonical for master/music to avoid coupling.
  private howlerMixBootSynced = false;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  public init(): void {
    if (this.ui) return;

    // Ensure a clean state on init (useful if system was disposed/re-inited)
    this.state = makeDefaultState();

    this.ui = new HarmonyUI({
      onTogglePlay: () => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.basic", true)) return;

        this.emit("audio:unlock-request", { source: "harmony-ui" });
        this.emit("audio:toggle-request", { source: "harmony" });
      },

      onSeek: (timeSec) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.basic", true)) return;

        this.emit("audio:seek-request", { timeSec, source: "harmony" });
      },

      onPrevTrack: () => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.transport", true)) return;

        this.emit("audio:unlock-request", { source: "harmony-ui" });
        this.emit("audio:cmd:prevTrack", { source: "harmony" });
      },

      onNextTrack: () => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.transport", true)) return;

        this.emit("audio:unlock-request", { source: "harmony-ui" });
        this.emit("audio:cmd:nextTrack", { source: "harmony" });
      },

      onToggleShuffle: () => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.shuffle", true)) return;
        this.setShuffle(!this.state.shuffle);
      },

      onCycleRepeat: () => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "playback.repeat", true)) return;
        this.cycleRepeat();
      },

      // Legacy hook: still supported if any UI calls it, but Harmony lanes are canonical now.
      onSetVolume: (volume01) => this.setVolume(volume01),

      onToggleEnvironmentPanel: () => {
        const caps = readCaps(this.state);
        const uiMode = readUiMode(this.state);
        if (uiMode === "cinematic") return;
        if (!capEnabled(caps, "env.panel", true)) return;
        this.toggleEnvironmentPanel();
      },

      onSetUIVisible: (visible) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "ui.hide", true)) return;
        this.setUIVisible(visible);
      },

      onToggleParticle: (id, enabled) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "env.particles", true)) return;

        const owner = readOwner(this.state);
        const unlocks = readUnlocks(this.state);
        if (!isUnlocked(owner, unlocks, "particle", String(id))) return;

        this.toggleParticle(String(id), enabled);
      },

      onToggleAmbient: (id, enabled) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "env.ambients", true)) return;

        const owner = readOwner(this.state);
        const unlocks = readUnlocks(this.state);
        if (!isUnlocked(owner, unlocks, "ambient", String(id))) return;

        this.toggleAmbient(String(id), enabled);
      },

      onSelectFilter: (id) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "env.filters", true)) return;

        const owner = readOwner(this.state);
        const unlocks = readUnlocks(this.state);
        if (!isUnlocked(owner, unlocks, "filter", String(id))) return;

        this.selectFilter(String(id));
      },

      // ✅ Presets: emit intent only; HarmonyPresetsSystem handles apply
      onApplyPreset: (presetId) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "env.presets", true)) return;

        const owner = readOwner(this.state);
        const unlocks = readUnlocks(this.state);
        if (!isUnlocked(owner, unlocks, "preset", String(presetId))) return;

        this.applyPreset(String(presetId));
      },

      onSetRitualDuration: (durationSec) => this.setRitualDuration(durationSec),

      // ✅ Howler lane sliders (Phase 1.5)
      onSetHowlerLane: (lane, volume01) => {
        const caps = readCaps(this.state);
        if (!capEnabled(caps, "mix.lanes", true)) return;
        this.setHowlerLane(lane, volume01);
      },

      // ✅ UI SFX hooks (canonical)
      onUiHover: () => this.emitUiHover(),
      onUiClick: () => this.emitUiClick(),
    });

    this.ui.mount(document.body);
    this.ui.render(this.state);

    // Audio state mirrors
    this.on("audio:state", (p: AudioStateEvent) => this.onAudioState(p));

    // ✅ Howler state mirrors (keeps lane sliders synced with actual audio state)
    this.on("howler:state", (p: any) => this.onHowlerState(p));

    // Harmony UI visibility controls
    this.on("harmony:ui:setVisible", (p: { visible: boolean }) => this.setUIVisible(Boolean(p?.visible)));
    this.on("harmony:ui:toggleVisible", () => this.setUIVisible(!this.state.uiVisible));

    // Environment panel controls
    this.on("harmony:environmentPanel:setOpen", (p: { open: boolean }) => this.setEnvironmentPanelOpen(Boolean(p?.open)));
    this.on("harmony:environmentPanel:toggle", () => this.toggleEnvironmentPanel());

    // ✅ Policy patches (Director/Lumen control surface)
    this.on("harmony:ui:policy", (p: any) => this.applyPolicyPatch(p));
    this.on("harmony:policy:set", (p: any) => this.applyPolicyPatch(p));
    this.on("harmony:state:patch", (p: any) => this.applyPolicyPatch(p));

    // ✅ Canonical environment state mirroring (boot restore, presets, etc.)
    this.on("harmony:environment:state", (p: unknown) => this.onEnvironmentState(p as HarmonyEnvironmentStateEvent));
    this.on("harmony:environment:changed", (p: unknown) => this.onEnvironmentState(p as HarmonyEnvironmentStateEvent));

    // ✅ Boot-sync handshake (covers late subscriber cases)
    this.emit("harmony:environment:requestState", { source: "harmony-ui" });

    // Also request current Howler mix so UI sliders can sync immediately.
    this.emit("howler:requestState", { source: "harmony-ui" });

    // Ensure AudioSystem starts aligned with current master/music lanes (if any).
    this.applyMusicMixToAudio("init");

    window.addEventListener("keydown", this.onKeyDown, { passive: true });
    this.disposers.push(() => window.removeEventListener("keydown", this.onKeyDown));
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];

    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = 0;
    this.renderQueued = false;

    if (this.musicMixRaf) cancelAnimationFrame(this.musicMixRaf);
    this.musicMixRaf = 0;
    this.musicMixPending = null;
    this.lastMusicMixSent = null;

    this.lastAudioApplied = null;
    this.lastEnvApplied = null;

    this.ui?.dispose();
    this.ui = null;
  }

  // ------------------------------------------------------------
  // ✅ UI SFX emitters (canonical names)
  // ------------------------------------------------------------

  private emitUiHover(): void {
    // IMPORTANT: Hover is NOT a user gesture for autoplay policies.
    this.emit("ui:sfx:hover", { source: "harmony" });
  }

  private emitUiClick(): void {
    // Click is a user gesture: ensure audio is unlocked before SFX playback attempts.
    this.emit("audio:unlock-request", { source: "harmony-ui-click" });
    this.emit("ui:sfx:click", { source: "harmony" });
  }

  // ------------------------------------------------------------
  // Policy patching (Director vs Lumen control surface)
  // ------------------------------------------------------------

  private applyPolicyPatch(patch: any): void {
    if (!patch || typeof patch !== "object") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = this.state as any;

    if (typeof patch.owner === "string") s.owner = patch.owner;
    if (typeof patch.uiMode === "string") s.uiMode = patch.uiMode;

    if (patch.capabilities && typeof patch.capabilities === "object") {
      s.capabilities = { ...(s.capabilities ?? {}), ...patch.capabilities };
    }

    if (patch.unlocks && typeof patch.unlocks === "object") {
      const prev = (s.unlocks ?? {}) as HarmonyUnlocksShape;
      const next = patch.unlocks as HarmonyUnlocksShape;

      s.unlocks = {
        ...prev,
        filters: { ...(prev.filters ?? {}), ...(next.filters ?? {}) },
        particles: { ...(prev.particles ?? {}), ...(next.particles ?? {}) },
        ambients: { ...(prev.ambients ?? {}), ...(next.ambients ?? {}) },
        presets: { ...(prev.presets ?? {}), ...(next.presets ?? {}) },
      };
    }

    this.requestRender();
  }

  // ------------------------------------------------------------
  // Presets (intent only)
  // ------------------------------------------------------------

  private applyPreset(presetId: string): void {
    const id = safeString(presetId, "").trim().toLowerCase();
    if (!id) return;
    this.emit("harmony:preset:apply", { presetId: id });
  }

  // ------------------------------------------------------------
  // Canonical environment mirroring (MVP: filter/particles/ambients only)
  // ------------------------------------------------------------

  private onEnvironmentState(payload: HarmonyEnvironmentStateEvent): void {
    const env = payload?.environment ?? payload?.state ?? {};

    const filterId = safeString(env.filterId ?? payload?.filterId, safeString(this.state.filterId, "f1"));

    const particles = safeBoolMap(env.particles ?? payload?.particles);
    const ambients = safeBoolMap(env.ambients ?? payload?.ambients);

    const prev = this.lastEnvApplied;

    const same =
      prev &&
      prev.filterId === filterId &&
      shallowBoolMapEquals(prev.particles, particles) &&
      shallowBoolMapEquals(prev.ambients, ambients);

    if (same) return;

    this.lastEnvApplied = { filterId, particles, ambients };

    this.state.filterId = filterId;
    this.state.particles = { ...particles };
    this.state.ambients = { ...ambients };

    this.requestRender();
  }

  // ------------------------------------------------------------
  // Audio mirroring
  // ------------------------------------------------------------

  private onAudioState(payload: AudioStateEvent): void {
    const s = payload?.state;
    if (!s) return;

    const playing = Boolean(s.isPlaying);
    const trackId = typeof s.activeTrackId === "string" ? s.activeTrackId : null;

    const timeSec = Number.isFinite(s.timeSec) ? Math.max(0, Number(s.timeSec)) : 0;
    const durationSec = Number.isFinite(s.durationSec ?? NaN) ? Math.max(0, Number(s.durationSec)) : 0;

    const shuffle = Boolean(s.shuffle);
    const repeat: RepeatMode = isRepeatMode(s.repeat) ? s.repeat : "off";
    const volume = to01(s.volume, this.state.volume);

    // Title from TrackCatalog
    let title = "";
    if (trackId) {
      const meta = getTrackMeta(trackId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      title = String((meta as any)?.title ?? (meta as any)?.label ?? (meta as any)?.name ?? "").trim();
    }
    if (!title) title = trackId ?? "No track";

    const snapshot: AudioSnapshot = {
      playing,
      trackId,
      title,
      positionSec: timeSec,
      durationSec,
      shuffle,
      repeat,
      volume,
    };

    if (this.lastAudioApplied && this.audioSnapshotEquals(this.lastAudioApplied, snapshot)) return;

    this.lastAudioApplied = snapshot;

    this.state.playing = playing;
    this.state.trackId = trackId;
    this.state.title = title;
    this.state.positionSec = timeSec;
    this.state.durationSec = durationSec;
    this.state.shuffle = shuffle;
    this.state.repeat = repeat;

    // NOTE:
    // AudioSystem reports its current volume. We mirror that as state.volume
    // so any legacy UI reads stay correct. Harmony mix lanes remain authoritative,
    // and we push desired volume via applyMusicMixToAudio().
    this.state.volume = volume;

    this.requestRender();
  }

  private onHowlerState(payload: any): void {
    const s = payload?.state;
    if (!s || typeof s !== "object") return;

    const cur = this.state.mix ?? HARMONY_DEFAULT_STATE.mix;

    // We always accept these lanes from Howler (Howler owns them).
    const next = {
      ...cur,
      sfx: to01((s as any).sfx, cur.sfx),
      ambient: to01((s as any).ambient, cur.ambient),
      ui: to01((s as any).ui, cur.ui),
    };

    // Boot sync: allow Howler to initialize master/music ONCE (first state payload),
    // but after that, Harmony is canonical for master/music to prevent coupling.
    if (!this.howlerMixBootSynced) {
      next.master = to01((s as any).master, cur.master);
      next.music = to01((s as any).music, cur.music);
      this.howlerMixBootSynced = true;
    }

    const same =
      cur.master === next.master &&
      cur.music === next.music &&
      cur.sfx === next.sfx &&
      cur.ambient === next.ambient &&
      cur.ui === next.ui;

    if (same) return;

    this.state.mix = next;

    // ✅ Keep AudioSystem obeying Master + Music lanes too.
    this.applyMusicMixToAudio("howler:state");

    this.requestRender();
  }

  private audioSnapshotEquals(a: AudioSnapshot, b: AudioSnapshot): boolean {
    return (
      a.playing === b.playing &&
      a.trackId === b.trackId &&
      a.title === b.title &&
      a.positionSec === b.positionSec &&
      a.durationSec === b.durationSec &&
      a.shuffle === b.shuffle &&
      a.repeat === b.repeat &&
      a.volume === b.volume
    );
  }

  // ------------------------------------------------------------
  // Mix policy: Harmony lanes must control everything
  // ------------------------------------------------------------

  private getMusicMixTarget(): number {
    const mix = this.state.mix ?? HARMONY_DEFAULT_STATE.mix;
    const master = to01(mix.master, 1);
    const music = to01(mix.music, 1);
    return clamp01(master * music);
  }

  /**
   * Applies Master+Music lane product to AudioSystem volume via EventBus.
   * This keeps track playback aligned with the same mixer concept as Howler.
   */
  private applyMusicMixToAudio(reason: string): void {
    const target = this.getMusicMixTarget();

    // Minor de-dupe (especially useful during slider drags)
    if (this.lastMusicMixSent != null && Math.abs(this.lastMusicMixSent - target) < 0.0005) return;

    this.musicMixPending = target;

    if (!this.musicMixRaf) {
      this.musicMixRaf = requestAnimationFrame(() => {
        this.musicMixRaf = 0;

        const v = this.musicMixPending;
        this.musicMixPending = null;
        if (v == null) return;

        // De-dupe again after RAF
        if (this.lastMusicMixSent != null && Math.abs(this.lastMusicMixSent - v) < 0.0005) return;
        this.lastMusicMixSent = v;

        // Push to AudioSystem (compat: emit both legacy + request names, and both key shapes)
        const payload = { volume: v, volume01: v, value01: v, source: "harmony-mix", reason };
        this.emit("audio:set-volume", payload);
        this.emit("audio:set-volume-request", payload);

        // Mirror immediately so UI stays responsive even before next audio:state
        this.state.volume = v;
        this.requestRender();
      });
    }
  }

  // ------------------------------------------------------------
  // UI state + commands
  // ------------------------------------------------------------

  private setUIVisible(visible: boolean): void {
    this.state.uiVisible = visible;

    // Nice UX: if you hide the UI, also close the panel so it doesn't stick open on show.
    if (!visible && this.state.environmentPanelOpen) {
      this.state.environmentPanelOpen = false;
    }

    this.requestRender();
  }

  private setEnvironmentPanelOpen(open: boolean): void {
    this.state.environmentPanelOpen = open;
    this.requestRender();
  }

  private toggleEnvironmentPanel(): void {
    this.setEnvironmentPanelOpen(!this.state.environmentPanelOpen);
  }

  private setShuffle(enabled: boolean): void {
    const v = Boolean(enabled);
    this.state.shuffle = v;
    this.emit("audio:set-shuffle", { shuffle: v, source: "harmony" });
    this.requestRender();
  }

  private cycleRepeat(): void {
    const next: RepeatMode = this.state.repeat === "off" ? "all" : this.state.repeat === "all" ? "one" : "off";
    this.state.repeat = next;
    this.emit("audio:set-repeat", { repeat: next, source: "harmony" });
    this.requestRender();
  }

  /**
   * Legacy setter: keep for compatibility, but treat Harmony lanes as canonical.
   *
   * This sets BOTH master & music to approximate the requested single volume,
   * without stomping other lanes (sfx/ambient/ui).
   */
  private setVolume(volume01: number): void {
    const v = to01(volume01, this.state.volume);

    // Map a single volume request into the master lane (and keep music at 1).
    this.state.mix = { ...(this.state.mix ?? HARMONY_DEFAULT_STATE.mix), master: v, music: 1.0 };

    // Tell HowlerAudioSystem (compat: include both value01 + volume01)
    this.emit("howler:volume:set", { bus: "master", value01: v, volume01: v, source: "harmony" });

    // Tell AudioSystem (master*music)
    this.applyMusicMixToAudio("setVolume");

    this.requestRender();
  }

  private setHowlerLane(lane: "master" | "music" | "sfx" | "ambient" | "ui", volume01: number): void {
    const cur = this.state.mix ?? HARMONY_DEFAULT_STATE.mix;
    const v = to01(volume01, to01(cur?.[lane], 1.0));

    // Update Harmony UI state immediately (so sliders feel responsive)
    this.state.mix = { ...(this.state.mix ?? HARMONY_DEFAULT_STATE.mix), [lane]: v };

    // Tell HowlerAudioSystem (compat: include both value01 + volume01)
    this.emit("howler:volume:set", { bus: lane, value01: v, volume01: v, source: "harmony" });

    // ✅ Also ensure AudioSystem obeys Master+Music lanes.
    if (lane === "master" || lane === "music") {
      this.applyMusicMixToAudio(`lane:${lane}`);
    }

    this.requestRender();
  }

  private selectFilter(filterId: string): void {
    this.state.filterId = filterId;

    // Emit both canonical + alias
    this.emit("harmony:environment:selectFilter", { filterId });
    this.emit("harmony:env:selectFilter", { filterId });

    this.requestRender();
  }

  private emitToggleParticleIntent(particleId: string, enabled: boolean): void {
    // Emit both canonical + alias
    this.emit("harmony:environment:toggleParticle", { particleId, enabled });
    this.emit("harmony:env:toggleParticle", { particleId, enabled });
  }

  private toggleParticle(particleId: string, enabled: boolean): void {
    // ✅ Make particles behave as a true radio group at the SYSTEM level.
    // Reason: if we only emit {id:false} on deselect, EnvironmentSystem may keep some other id true,
    // and ParticleFX will “stick” to the last canonical true entry.
    const prev = this.state.particles ?? {};
    const next = applyParticleRadioLocal(prev, particleId, enabled);

    // Emit intents for every changed key so the environment becomes canonical-radio too.
    for (const [k, v] of Object.entries(next)) {
      if (prev[k] === v) continue;
      this.emitToggleParticleIntent(k, v);
    }

    // Mirror locally immediately for responsive UI
    this.state.particles = next;

    this.requestRender();
  }

  private toggleAmbient(ambientId: string, enabled: boolean): void {
    this.state.ambients = { ...(this.state.ambients ?? {}), [ambientId]: enabled };

    // Emit both canonical + alias
    this.emit("harmony:environment:toggleAmbient", { ambientId, enabled });
    this.emit("harmony:env:toggleAmbient", { ambientId, enabled });

    this.requestRender();
  }

  private setRitualDuration(durationSec: number): void {
    const clamped = Math.max(10, Math.min(600, Math.floor(durationSec)));
    this.state.ritualDurationSec = clamped;
    this.emit("ritual:setDuration", { durationSec: clamped });
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.ui) return;
    if (this.renderQueued) return;

    this.renderQueued = true;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      this.renderQueued = false;
      this.ui?.render(this.state);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emit(event: string, payload?: any): void {
    this.bus.emit(event, payload);
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.state.environmentPanelOpen) this.setEnvironmentPanelOpen(false);
  };
}

// ✅ Guaranteed named export (matches `import { HarmonySystem } ...`)
export { HarmonySystem };