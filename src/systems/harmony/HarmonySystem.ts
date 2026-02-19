// src/systems/harmony/HarmonySystem.ts
// ============================================================
// THE STILL — HarmonySystem
//  - Owns Harmony UI state
//  - Talks only through EventBus (no AudioSystem imports)
//  - Mirrors canonical environment snapshots from HarmonyEnvironmentSystem
// ============================================================

import type { EventBus } from "../../core/EventBus";
import { HarmonyUI } from "./HarmonyUI";
import { HARMONY_DEFAULT_STATE, type HarmonyState, type AudioStateEvent } from "./types";
import type { RepeatMode } from "../PersistenceSystem";
import { getTrackMeta } from "./TrackCatalog";

type AnyFn = (...args: any[]) => void;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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
  colorId?: string;
  filterId?: string;
  particles?: Record<string, boolean>;
  ambients?: Record<string, boolean>;
};

type HarmonyEnvironmentStateEvent = {
  environment: HarmonyEnvironmentSnapshot;
  reason: string;
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

const makeDefaultState = (): HarmonyState => {
  // Important: avoid sharing nested object references if defaults are reused.
  return {
    ...HARMONY_DEFAULT_STATE,
    particles: { ...(HARMONY_DEFAULT_STATE.particles ?? {}) },
    ambients: { ...(HARMONY_DEFAULT_STATE.ambients ?? {}) },
  };
};

export class HarmonySystem {
  private bus: EventBus;
  private ui: HarmonyUI | null = null;
  private state: HarmonyState = makeDefaultState();
  private disposers: Array<() => void> = [];

  private renderRaf = 0;
  private renderQueued = false;

  private lastAudioApplied: AudioSnapshot | null = null;

  // Track last environment snapshot applied to avoid redundant renders
  private lastEnvApplied: {
    colorId: string;
    filterId: string;
    particles: Record<string, boolean>;
    ambients: Record<string, boolean>;
  } | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  public init(): void {
    if (this.ui) return;

    // Ensure a clean state on init (useful if system was disposed/re-inited)
    this.state = makeDefaultState();

    this.ui = new HarmonyUI({
      onTogglePlay: () => {
        this.emit("audio:unlock-request", {});
        this.emit("audio:toggle-request", { source: "harmony" });
      },

      onSeek: (timeSec) => {
        this.emit("audio:seek-request", { timeSec, source: "harmony" });
      },

      onPrevTrack: () => {
        this.emit("audio:unlock-request", {});
        this.emit("audio:cmd:prevTrack", { source: "harmony" });
      },

      onNextTrack: () => {
        this.emit("audio:unlock-request", {});
        this.emit("audio:cmd:nextTrack", { source: "harmony" });
      },

      onToggleShuffle: () => this.setShuffle(!this.state.shuffle),
      onCycleRepeat: () => this.cycleRepeat(),
      onSetVolume: (volume01) => this.setVolume(volume01),

      onToggleEnvironmentPanel: () => this.toggleEnvironmentPanel(),
      onSetUIVisible: (visible) => this.setUIVisible(visible),

      onToggleParticle: (id, enabled) => this.toggleParticle(id, enabled),
      onToggleAmbient: (id, enabled) => this.toggleAmbient(id, enabled),
      onSelectColor: (id) => this.selectColor(id),
      onSelectFilter: (id) => this.selectFilter(id),

      // ✅ Presets: emit intent only; HarmonyPresetsSystem handles catalog + apply
      onApplyPreset: (presetId) => this.applyPreset(presetId),

      onSetRitualDuration: (durationSec) => this.setRitualDuration(durationSec),

      // ✅ UI SFX hooks (canonical)
      onUiHover: () => this.emitUiHover(),
      onUiClick: () => this.emitUiClick(),
    });

    this.ui.mount(document.body);
    this.ui.render(this.state);

    // Audio state mirrors
    this.on("audio:state", (p: AudioStateEvent) => this.onAudioState(p));

    // Harmony UI visibility controls
    this.on("harmony:ui:setVisible", (p: { visible: boolean }) => this.setUIVisible(Boolean(p?.visible)));
    this.on("harmony:ui:toggleVisible", () => this.setUIVisible(!this.state.uiVisible));

    // Environment panel controls
    this.on("harmony:environmentPanel:setOpen", (p: { open: boolean }) => this.setEnvironmentPanelOpen(Boolean(p?.open)));
    this.on("harmony:environmentPanel:toggle", () => this.toggleEnvironmentPanel());

    // ✅ Canonical environment state mirroring (boot restore, presets, etc.)
    this.on("harmony:environment:state", (p: any) => this.onEnvironmentState(p as HarmonyEnvironmentStateEvent));
    // Optional: if you use this elsewhere, mirroring it too doesn't hurt.
    this.on("harmony:environment:changed", (p: any) => this.onEnvironmentState(p as HarmonyEnvironmentStateEvent));

    window.addEventListener("keydown", this.onKeyDown, { passive: true });
    this.disposers.push(() => window.removeEventListener("keydown", this.onKeyDown));
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];

    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = 0;
    this.renderQueued = false;

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
    // Do NOT attempt unlock here or Chrome will warn.
    this.emit("ui:sfx:hover", { source: "harmony" });
  }

  private emitUiClick(): void {
    // Click is a user gesture: ensure audio is unlocked before SFX playback attempts.
    this.emit("audio:unlock-request", { source: "harmony-ui-click" });
    this.emit("ui:sfx:click", { source: "harmony" });
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
  // Canonical environment mirroring
  // ------------------------------------------------------------

  private onEnvironmentState(payload: HarmonyEnvironmentStateEvent): void {
    const env = payload?.environment ?? {};

    const colorId = safeString(env.colorId, safeString((this.state as any).colorId, "c1"));
    const filterId = safeString(env.filterId, safeString((this.state as any).filterId, "f1"));

    const particles = safeBoolMap(env.particles);
    const ambients = safeBoolMap(env.ambients);

    const prev = this.lastEnvApplied;

    const same =
      prev &&
      prev.colorId === colorId &&
      prev.filterId === filterId &&
      shallowBoolMapEquals(prev.particles, particles) &&
      shallowBoolMapEquals(prev.ambients, ambients);

    if (same) return;

    this.lastEnvApplied = { colorId, filterId, particles, ambients };

    this.state.colorId = colorId;
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
    const volume = clamp01(Number.isFinite(s.volume) ? Number(s.volume) : this.state.volume);

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
    this.state.volume = volume;

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
  // UI state + commands
  // ------------------------------------------------------------

  private setUIVisible(visible: boolean): void {
    this.state.uiVisible = visible;

    // Nice UX: if you hide the UI, also close the panel so it doesn't "stick" open on show.
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

  private setVolume(volume01: number): void {
    const v = clamp01(Number.isFinite(volume01) ? volume01 : this.state.volume);
    this.state.volume = v;
    this.emit("audio:set-volume", { volume: v, source: "harmony" });
    this.requestRender();
  }

  private selectColor(colorId: string): void {
    this.state.colorId = colorId;
    // ✅ align with HarmonyEnvironmentSystem event names
    this.emit("harmony:environment:selectColor", { colorId });
    this.requestRender();
  }

  private selectFilter(filterId: string): void {
    this.state.filterId = filterId;
    // ✅ align with HarmonyEnvironmentSystem event names
    this.emit("harmony:environment:selectFilter", { filterId });
    this.requestRender();
  }

  private toggleParticle(particleId: string, enabled: boolean): void {
    // Avoid in-place mutation in case state is ever frozen/serialized differently.
    this.state.particles = { ...(this.state.particles ?? {}), [particleId]: enabled };
    // ✅ align with HarmonyEnvironmentSystem event names
    this.emit("harmony:environment:toggleParticle", { particleId, enabled });
    this.requestRender();
  }

  private toggleAmbient(ambientId: string, enabled: boolean): void {
    this.state.ambients = { ...(this.state.ambients ?? {}), [ambientId]: enabled };
    // ✅ align with HarmonyEnvironmentSystem event names
    this.emit("harmony:environment:toggleAmbient", { ambientId, enabled });
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
