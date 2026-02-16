// src/systems/harmony/HarmonySystem.ts
// ============================================================
// THE STILL — HarmonySystem
//  - Owns Harmony UI state
//  - Talks only through EventBus (no AudioSystem imports)
// ============================================================

import type { EventBus } from "../../core/EventBus";
import { HarmonyUI } from "./HarmonyUI";
import { HARMONY_DEFAULT_STATE, type HarmonyState, type AudioStateEvent } from "./types";
import type { RepeatMode } from "../PersistenceSystem";

type AnyFn = (...args: any[]) => void;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class HarmonySystem {
  private bus: EventBus;
  private ui: HarmonyUI | null = null;
  private state: HarmonyState = { ...HARMONY_DEFAULT_STATE };
  private disposers: Array<() => void> = [];

  // Coalesce UI renders to 1x/RAF (prevents UI “stickiness” under load)
  private renderRaf = 0;
  private renderQueued = false;

  // NEW: keep last applied audio snapshot so we can skip pointless renders
  private lastAudioApplied: {
    playing: boolean;
    trackId: string | null;
    title: string;
    positionSec: number;
    durationSec: number;
    shuffle: boolean;
    repeat: RepeatMode;
    volume: number;
  } | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  public init(): void {
    if (this.ui) return;

    this.ui = new HarmonyUI({
      onTogglePlay: () => {
        // Ensure browser audio is unlocked (safe even if already unlocked)
        this.emit("audio:unlock-request", {});
        // Request-style event consumed by AudioSystem
        this.emit("audio:toggle-request", { source: "harmony" });
        // Do not force local play state; AudioSystem is the authority.
      },

      onSeek: (timeSec) => {
        this.emit("audio:seek-request", { timeSec, source: "harmony" });
        // No local position write here; AudioSystem will confirm via audio:state ticks.
      },

      // NEW: Prev/Next track (Phase 2 navigation)
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

      onToggleVibePanel: () => this.toggleVibePanel(),
      onSetUIVisible: (visible) => this.setUIVisible(visible),

      onToggleParticle: (id, enabled) => this.toggleParticle(id, enabled),
      onToggleAmbient: (id, enabled) => this.toggleAmbient(id, enabled),
      onSelectColor: (id) => this.selectColor(id),
      onSelectFilter: (id) => this.selectFilter(id),

      onSetRitualDuration: (durationSec) => this.setRitualDuration(durationSec),
    });

    this.ui.mount(document.body);
    this.ui.render(this.state);

    // Bus subscriptions
    this.on("audio:state", (p: AudioStateEvent) => this.onAudioState(p));

    this.on("harmony:ui:setVisible", (p: { visible: boolean }) => this.setUIVisible(Boolean(p?.visible)));
    this.on("harmony:ui:toggleVisible", () => this.setUIVisible(!this.state.uiVisible));

    this.on("harmony:vibePanel:setOpen", (p: { open: boolean }) => this.setVibePanelOpen(Boolean(p?.open)));
    this.on("harmony:vibePanel:toggle", () => this.toggleVibePanel());

    // Small UX: ESC closes the vibe panel
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

    this.ui?.dispose();
    this.ui = null;
  }

  // ------------------------------------------------------------
  // State updates
  // ------------------------------------------------------------

  private onAudioState(payload: AudioStateEvent): void {
    // Strict contract: AudioSystem emits { state, reason }
    const s = payload?.state;
    if (!s) return;

    const playing = Boolean(s.isPlaying);
    const trackId = (s.activeTrackId ?? null) as string | null;

    const timeSec = Number.isFinite(s.timeSec) ? s.timeSec : 0;
    const durationSec = Number.isFinite(s.durationSec ?? NaN) ? Number(s.durationSec) : 0;

    const shuffle = Boolean(s.shuffle);
    const repeat = (s.repeat ?? "off") as RepeatMode;
    const volume = clamp01(Number.isFinite(s.volume) ? s.volume : this.state.volume);

    const safeRepeat: RepeatMode = repeat === "off" || repeat === "one" || repeat === "all" ? repeat : "off";

    const title = typeof payload.title === "string" && payload.title ? payload.title : trackId ?? "No track";

    // Skip doing work if nothing meaningful changed (reduces Safari hiccups)
    const snapshot = {
      playing,
      trackId,
      title,
      positionSec: timeSec,
      durationSec,
      shuffle,
      repeat: safeRepeat,
      volume,
    };

    if (this.lastAudioApplied && this.audioSnapshotEquals(this.lastAudioApplied, snapshot)) {
      return;
    }

    this.lastAudioApplied = snapshot;

    this.state.playing = playing;
    this.state.trackId = trackId;
    this.state.title = title;
    this.state.positionSec = timeSec;
    this.state.durationSec = durationSec;

    this.state.shuffle = shuffle;
    this.state.repeat = safeRepeat;
    this.state.volume = volume;

    this.requestRender();
  }

  private audioSnapshotEquals(
    a: NonNullable<HarmonySystem["lastAudioApplied"]>,
    b: NonNullable<HarmonySystem["lastAudioApplied"]>,
  ): boolean {
    // NOTE: positionSec changes frequently; we still compare it.
    // If you ever want even less churn, you can quantize positionSec to, say, 0.05s here.
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

  private setUIVisible(visible: boolean): void {
    this.state.uiVisible = visible;
    this.requestRender();
  }

  private setVibePanelOpen(open: boolean): void {
    this.state.vibePanelOpen = open;
    this.requestRender();
  }

  private toggleVibePanel(): void {
    this.setVibePanelOpen(!this.state.vibePanelOpen);
  }

  private setShuffle(enabled: boolean): void {
    const v = Boolean(enabled);

    // Optimistic UI
    this.state.shuffle = v;
    this.emit("audio:set-shuffle", { shuffle: v, source: "harmony" });

    this.requestRender();
  }

  private cycleRepeat(): void {
    const next: RepeatMode = this.state.repeat === "off" ? "all" : this.state.repeat === "all" ? "one" : "off";

    // Optimistic UI
    this.state.repeat = next;
    this.emit("audio:set-repeat", { repeat: next, source: "harmony" });

    this.requestRender();
  }

  private setVolume(volume01: number): void {
    const v = clamp01(Number.isFinite(volume01) ? volume01 : this.state.volume);

    // Optimistic UI
    this.state.volume = v;
    this.emit("audio:set-volume", { volume: v, source: "harmony" });

    this.requestRender();
  }

  private selectColor(colorId: string): void {
    this.state.colorId = colorId;
    this.emit("vibe:selectColor", { colorId });
    this.requestRender();
  }

  private selectFilter(filterId: string): void {
    this.state.filterId = filterId;
    this.emit("vibe:selectFilter", { filterId });
    this.requestRender();
  }

  private toggleParticle(particleId: string, enabled: boolean): void {
    this.state.particles[particleId] = enabled;
    this.emit("vibe:toggleParticle", { particleId, enabled });
    this.requestRender();
  }

  private toggleAmbient(ambientId: string, enabled: boolean): void {
    this.state.ambients[ambientId] = enabled;
    this.emit("vibe:toggleAmbient", { ambientId, enabled });
    this.requestRender();
  }

  private setRitualDuration(durationSec: number): void {
    const clamped = Math.max(10, Math.min(600, Math.floor(durationSec)));
    this.state.ritualDurationSec = clamped;
    this.emit("ritual:setDuration", { durationSec: clamped });
    this.requestRender();
  }

  // one render per RAF
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

  // ------------------------------------------------------------
  // EventBus adapter (centralized)
  // ------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emit(event: string, payload?: any): void {
    this.bus.emit(event, payload);
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);

    this.disposers.push(() => {
      this.bus.off(event, handler);
    });
  }

  // ------------------------------------------------------------
  // UX
  // ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.state.vibePanelOpen) {
      this.setVibePanelOpen(false);
    }
  };
}
