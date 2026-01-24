// src/systems/AudioSystem.ts
// ============================================================
// THE STILL — Phase 1
// AudioSystem (Skeleton)
// ------------------------------------------------------------
// Responsibilities:
//  - Engine-owned audio state + playback orchestration (no UI)
//  - Listen/respond to Gate + Dev events via EventBus
//  - Persist player settings via PersistenceSystem
//
// Notes:
//  - This is intentionally a skeleton: it focuses on state, events, and fades.
//  - Actual track loading/decoding + WebAudio graph will be added next.
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PersistenceSystem, RepeatMode } from "./PersistenceSystem";

export type AudioFadeReason = "gate" | "user" | "system";

export type AudioSystemState = {
  activeTrackId: string | null;
  isPlaying: boolean;

  /** Logical playhead in seconds (skeleton advances this in update). */
  timeSec: number;

  /** Duration (seconds) if known; null in skeleton until we load media. */
  durationSec: number | null;

  shuffle: boolean;
  repeat: RepeatMode;

  /** User volume preference (0..1). */
  volume: number;

  /** Effective volume after fades/ducking (0..1). */
  effectiveVolume: number;

  /** True when Gate has forced silence (or other system-level mute). */
  systemMuted: boolean;
};

type FadeState = {
  active: boolean;
  from: number;
  to: number;
  t: number;
  duration: number;
  reason: AudioFadeReason;
};

export interface AudioSystemDeps {
  bus: EventBus;
  persistence: PersistenceSystem;

  /**
   * Default fade duration used by system-level fades (Gate close).
   * Keeping this short makes the Still feel deliberate, not abrupt.
   */
  defaultFadeMs?: number;
}

export class AudioSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;

  private readonly defaultFadeSec: number;

  private state: AudioSystemState;

  private fade: FadeState = {
    active: false,
    from: 1,
    to: 1,
    t: 1,
    duration: 0,
    reason: "system",
  };

  private prevPlayingBeforeSystemMute = false;

  constructor(deps: AudioSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.defaultFadeSec = Math.max(0, (deps.defaultFadeMs ?? 800) / 1000);

    const user = this.persistence.getState();

    this.state = {
      activeTrackId: user.audio.activeTrackId,
      isPlaying: false,
      timeSec: 0,
      durationSec: null,

      shuffle: user.audio.shuffle,
      repeat: user.audio.repeat,
      volume: user.audio.volume,

      effectiveVolume: user.audio.volume,
      systemMuted: false,
    };

    this.attachBusHandlers();

    // Announce initial state for DebugOverlay / diagnostics
    this.emitState("init");
  }

  // ---------------------------------------------------------------------------
  // Public API (Engine/systems can call; UI will call via events later)
  // ---------------------------------------------------------------------------

  getState(): AudioSystemState {
    return structuredClone(this.state);
  }

  /**
   * DEV/Diagnostics: re-emit current state (useful when DebugOverlay subscribes after init).
   */
  announceState(reason = "audio:announce"): void {
    this.emitState(reason);
  }


  setTrack(trackId: string | null, reason = "audio:set-track"): void {
    if (this.state.activeTrackId === trackId) return;
    this.state.activeTrackId = trackId;
    this.state.timeSec = 0;
    this.state.durationSec = null;

    this.persistence.setAudioPlayer({ activeTrackId: trackId }, reason);
    this.emitState(reason);
  }

  play(reason = "audio:play"): void {
    if (this.state.systemMuted) {
      // Remember intent; Gate will resume when it opens.
      this.prevPlayingBeforeSystemMute = true;
      this.emitState(reason);
      return;
    }

    if (this.state.isPlaying) return;
    this.state.isPlaying = true;
    this.emit("audio:play", { trackId: this.state.activeTrackId });
    this.emitState(reason);
  }

  pause(reason = "audio:pause"): void {
    if (!this.state.isPlaying) return;
    this.state.isPlaying = false;
    this.emit("audio:pause", { trackId: this.state.activeTrackId });
    this.emitState(reason);
  }

  togglePlay(reason = "audio:toggle"): void {
    if (this.state.isPlaying) this.pause(reason);
    else this.play(reason);
  }

  seek(timeSec: number, reason = "audio:seek"): void {
    const t = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
    this.state.timeSec = t;
    this.emit("audio:seek", { timeSec: t, trackId: this.state.activeTrackId });
    this.emitState(reason);
  }

  setVolume(volume01: number, reason = "audio:volume"): void {
    const v = clamp01(volume01);
    if (Math.abs(this.state.volume - v) < 0.0001) return;

    this.state.volume = v;
    this.persistence.setAudioPlayer({ volume: v }, reason);

    // If no fade is active, update effective volume immediately.
    if (!this.fade.active) {
      this.state.effectiveVolume = this.computeEffectiveVolume();
    }

    this.emit("audio:volume", { volume: v });
    this.emitState(reason);
  }

  setShuffle(enabled: boolean, reason = "audio:shuffle"): void {
    const v = !!enabled;
    if (this.state.shuffle === v) return;
    this.state.shuffle = v;
    this.persistence.setAudioPlayer({ shuffle: v }, reason);
    this.emit("audio:shuffle", { shuffle: v });
    this.emitState(reason);
  }

  setRepeat(mode: RepeatMode, reason = "audio:repeat"): void {
    if (this.state.repeat === mode) return;
    this.state.repeat = mode;
    this.persistence.setAudioPlayer({ repeat: mode }, reason);
    this.emit("audio:repeat", { repeat: mode });
    this.emitState(reason);
  }

  /**
   * System-level mute to silence all audio (Gate close).
   * This does NOT clear user volume or preferences.
   */
  fadeToSilence(reason: AudioFadeReason = "system", durationSec?: number): void {
    const dur = Math.max(0, durationSec ?? this.defaultFadeSec);

    // Preserve intent if currently playing.
    this.prevPlayingBeforeSystemMute = this.state.isPlaying;

    this.state.systemMuted = true;
    this.startFade(this.state.effectiveVolume, 0, dur, reason);

    // We intentionally stop logical playback when system mutes.
    // When resumeSystemAudio() is called, we restore play intent.
    this.state.isPlaying = false;

    this.emit("audio:fade-to-silence", { reason, durationSec: dur });
    this.emitState("audio:fade-to-silence");
  }

  resumeSystemAudio(reason: AudioFadeReason = "system", durationSec?: number): void {
    const dur = Math.max(0, durationSec ?? this.defaultFadeSec);

    this.state.systemMuted = false;

    const target = this.computeEffectiveVolume({ ignoreFade: true });
    this.startFade(this.state.effectiveVolume, target, dur, reason);

    // Restore intent (if we were playing pre-mute)
    if (this.prevPlayingBeforeSystemMute) {
      this.state.isPlaying = true;
      this.emit("audio:play", { trackId: this.state.activeTrackId });
    }

    this.prevPlayingBeforeSystemMute = false;

    this.emit("audio:resume", { reason, durationSec: dur });
    this.emitState("audio:resume");
  }

  // ---------------------------------------------------------------------------
  // Engine lifecycle
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    // Advance a logical playhead until real media timing arrives.
    if (this.state.isPlaying && !this.state.systemMuted) {
      this.state.timeSec += Math.max(0, dt);
    }

    if (this.fade.active) {
      const d = Math.max(0.000001, this.fade.duration);
      this.fade.t = clamp01(this.fade.t + dt / d);

      const v = lerp(this.fade.from, this.fade.to, this.fade.t);
      this.state.effectiveVolume = clamp01(v);

      if (this.fade.t >= 1) {
        this.fade.active = false;
        this.state.effectiveVolume = this.computeEffectiveVolume();
      }
    }
  }

  dispose(): void {
    this.detachBusHandlers();
  }

  // ---------------------------------------------------------------------------
  // EventBus wiring
  // ---------------------------------------------------------------------------

  private handlers: Array<{
    event: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (payload: any) => void;
  }> = [];

  private attachBusHandlers(): void {
    // Dev + UI events (later UI will emit these)
    this.bind("audio:set-track", (p: { trackId: string | null }) => this.setTrack(p?.trackId ?? null));
    this.bind("audio:play-request", () => this.play("audio:play-request"));
    this.bind("audio:pause-request", () => this.pause("audio:pause-request"));
    this.bind("audio:toggle-request", () => this.togglePlay("audio:toggle-request"));
    this.bind("audio:seek", (p: { timeSec: number }) => this.seek(p?.timeSec ?? 0, "audio:seek"));
    this.bind("audio:set-volume", (p: { volume: number }) => this.setVolume(p?.volume ?? this.state.volume, "audio:set-volume"));
    this.bind("audio:set-shuffle", (p: { shuffle: boolean }) => this.setShuffle(!!p?.shuffle, "audio:set-shuffle"));
    this.bind("audio:set-repeat", (p: { repeat: RepeatMode }) => this.setRepeat(p?.repeat ?? this.state.repeat, "audio:set-repeat"));

    // Gate/system events
    this.bind("audio:fade-to-silence", (p: { reason?: AudioFadeReason; durationSec?: number }) =>
      this.fadeToSilence(p?.reason ?? "system", p?.durationSec)
    );

    this.bind("audio:resume", (p: { reason?: AudioFadeReason; durationSec?: number }) =>
      this.resumeSystemAudio(p?.reason ?? "system", p?.durationSec)
    );

    // Safety: Gate can also emit these
    this.bind("gate:closing", () => this.fadeToSilence("gate"));
    this.bind("gate:opening", () => this.resumeSystemAudio("gate"));
  }

  private detachBusHandlers(): void {
    for (const h of this.handlers) {
      this.bus.off(h.event, h.fn);
    }
    this.handlers = [];
  }

  private bind<T>(event: string, fn: (payload: T) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyFn = fn as any;
    this.handlers.push({ event, fn: anyFn });
    this.bus.on(event, anyFn);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private emit(event: string, payload: unknown): void {
    this.bus.emit(event, payload);
  }

  private emitState(reason: string): void {
    this.bus.emit("audio:state", { state: this.getState(), reason });
  }

  private startFade(from: number, to: number, durationSec: number, reason: AudioFadeReason): void {
    this.fade = {
      active: durationSec > 0,
      from: clamp01(from),
      to: clamp01(to),
      t: durationSec > 0 ? 0 : 1,
      duration: Math.max(0, durationSec),
      reason,
    };

    if (!this.fade.active) {
      this.state.effectiveVolume = clamp01(to);
    }
  }

  private computeEffectiveVolume(opts?: { ignoreFade?: boolean }): number {
    if (this.state.systemMuted) return 0;
    if (!opts?.ignoreFade && this.fade.active) return this.state.effectiveVolume;
    return clamp01(this.state.volume);
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
