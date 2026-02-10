// src/systems/AudioSystem.ts
// ============================================================
// THE STILL — Phase 1
// AudioSystem (Playback MVP)
// ------------------------------------------------------------
// Responsibilities:
//  - Engine-owned audio state + playback orchestration (no UI)
//  - Listen/respond to Gate + Dev events via EventBus
//  - Persist player settings via PersistenceSystem
//
// MVP:
//  - WebAudio unlock + minimal graph (music channel only for now)
//  - Load + play an mp3 (trackId -> url candidates) via fetch + decode
//  - Play/Pause/Seek/Volume; emits audio:state + diagnostics
//
// Notes:
//  - Track catalog is intentionally "best-effort" URL resolution right now.
//    We'll formalize this into a proper TrackRegistry later.
//  - IMPORTANT ARCH RULE:
//      "audio:fade-to-silence" and "audio:resume" are *REQUEST* events.
//      AudioSystem must NEVER emit them, or it can recurse through its own handlers.
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PersistenceSystem, RepeatMode } from "./PersistenceSystem";

export type AudioFadeReason = "gate" | "user" | "system";

export type AudioSystemState = {
  activeTrackId: string | null;
  isPlaying: boolean;

  /** Playhead in seconds (authoritative once WebAudio is running). */
  timeSec: number;

  /** Duration (seconds) if known; null until media is decoded. */
  durationSec: number | null;

  shuffle: boolean;
  repeat: RepeatMode;

  /** User volume preference (0..1). */
  volume: number;

  /** Effective volume after fades (0..1). */
  effectiveVolume: number;

  /** True when Gate has forced silence (or other system-level mute). */
  systemMuted: boolean;

  /** Browser audio is unlocked (AudioContext is running). */
  isUnlocked: boolean;

  /** Last unlock/playback related error (dev only). */
  lastError: string | null;
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

  // ----------------------------------------------------------
  // WebAudio
  // ----------------------------------------------------------

  private audioCtx: AudioContext | null = null;
  private readonly AudioContextCtor: (new () => AudioContext) | null =
    (globalThis.AudioContext ?? (globalThis as any).webkitAudioContext ?? null);

  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;

  private decoded: Map<string, AudioBuffer> = new Map();

  private musicSource: AudioBufferSourceNode | null = null;
  private musicStartAtCtxTime = 0; // ctx.currentTime at start()
  private musicStartOffsetSec = 0; // offset passed into start()

  // ----------------------------------------------------------
  // Audio frame (FFT -> bands) for reactive systems
  // ----------------------------------------------------------

  private fftBins: Uint8Array | null = null;

  // Throttle bus emissions to avoid log spam.
  private readonly frameHz = 30;
  private lastFrameEmitCtxTime = -1;

  // Smoothed bands (0..1). Keeps the Core from jittering like a caffeinated firefly.
  private smoothedEnergy = 0;
  private smoothedLow = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;

  // NEW: "note pop" onset (0..1)
  private smoothedOnset = 0;
  private prevRawEnergy = 0;

  // NEW: onset tuning (safe defaults, easy to tweak)
  // - onsetGain: increases sensitivity to small plucks/notes (quiet tracks)
  // - onsetAttackHz: how fast onset rises (higher = snappier)
  // - onsetReleaseHz: how fast onset falls (higher = shorter pop)
  private readonly onsetGain = 14; // try 10..22
  private readonly onsetAttackHz = 80; // try 60..140
  private readonly onsetReleaseHz = 16; // try 10..28

  // Existing smoothing speed for bands/energy
  private readonly bandSmoothHz = 10; // ~fast but not twitchy

  // NEW: peak hold (0..1) for "big moment" visuals.
  // Use this when you want the ring to "fill" at musical peaks, even if the peak is brief.
  private peakHold = 0;
  private readonly peakDecayPerSec = 0.42; // try 0.25..0.80 (lower = longer hang)

  // ----------------------------------------------------------
  // Bus wiring
  // ----------------------------------------------------------

  private handlers: Array<{
    event: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (payload: any) => void;
  }> = [];

  constructor(deps: AudioSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.defaultFadeSec = Math.max(0, (deps.defaultFadeMs ?? 800) / 1000);

    const user = this.persistence.getState();

    this.state = {
      activeTrackId: user.audio.activeTrackId ?? null,
      isPlaying: false,
      timeSec: user.audio.timeSec ?? 0,
      durationSec: user.audio.durationSec ?? null,

      shuffle: user.audio.shuffle ?? false,
      repeat: user.audio.repeat ?? "off",
      volume: clamp01(user.audio.volume ?? 0.85),

      effectiveVolume: clamp01(user.audio.volume ?? 0.85),
      systemMuted: false,
      isUnlocked: false,
      lastError: null,
    };

    this.attachBusHandlers();

    // Announce initial state for DebugOverlay / diagnostics
    this.emitState("init");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getState(): AudioSystemState {
    // IMPORTANT:
    // - This state is flat primitives, so a shallow clone is enough.
    // - Avoid structuredClone here; it can throw if state ever gains non-cloneable fields.
    return { ...this.state };
  }

  /**
   * DEV/Diagnostics: re-emit current state (useful when DebugOverlay subscribes after init).
   */
  announceState(reason = "audio:announce"): void {
    this.persistPlayer(reason);
    this.emitState(reason);
  }

  /**
   * Unlock browser audio via a user gesture (pointerdown/keydown).
   */
  async unlock(reason = "audio:unlock"): Promise<void> {
    if (this.state.isUnlocked) {
      this.emitState(reason);
      return;
    }

    if (!this.AudioContextCtor) {
      this.state.lastError = "AudioContext is not available in this browser.";
      this.emit("audio:unlock-failed", { reason: "no-audiocontext" });
      this.emitState("audio:unlock-failed");
      return;
    }

    try {
      if (!this.audioCtx) this.audioCtx = new this.AudioContextCtor();
      if (this.audioCtx.state !== "running") await this.audioCtx.resume();

      this.state.isUnlocked = this.audioCtx.state === "running";
      this.state.lastError = null;

      if (this.state.isUnlocked) this.buildGraph();

      this.emit("audio:unlocked", { state: this.audioCtx.state });
      this.emitState(reason);

      // If user previously hit play while locked, resume intent.
      if (this.prevPlayingBeforeSystemMute && !this.state.systemMuted) {
        this.prevPlayingBeforeSystemMute = false;
        void this.play("audio:auto-resume-after-unlock");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.lastError = msg;
      this.emit("audio:unlock-failed", { reason: "exception", message: msg });
      this.emitState("audio:unlock-failed");
    }
  }

  setTrack(trackId: string | null, reason = "audio:set-track"): void {
    if (this.state.activeTrackId === trackId) return;

    const wasPlaying = this.state.isPlaying;
    if (wasPlaying) this.pause("audio:set-track-stop");

    this.state.activeTrackId = trackId;
    this.state.timeSec = 0;
    this.state.durationSec = null;

    this.persistence.setAudioPlayer({ activeTrackId: trackId, timeSec: 0, durationSec: null }, reason);
    this.emit("audio:set-track", { trackId });
    this.emitState(reason);

    if (wasPlaying) void this.play("audio:set-track-restart");
  }

  async play(reason = "audio:play"): Promise<void> {
    if (this.state.systemMuted) {
      this.prevPlayingBeforeSystemMute = true;
      this.emitState(reason);
      return;
    }

    if (!this.state.isUnlocked) {
      this.prevPlayingBeforeSystemMute = true;
      this.emit("audio:unlock-required", {});
      this.emitState("audio:unlock-required");
      return;
    }

    if (this.state.isPlaying) return;

    if (!this.state.activeTrackId) {
      this.state.lastError = "No activeTrackId set. (Try audio:set-track first)";
      this.emit("audio:play-failed", { reason: "no-track" });
      this.emitState("audio:play-failed");
      return;
    }

    try {
      await this.ensureGraph();

      const buffer = await this.getDecodedBuffer(this.state.activeTrackId);
      this.state.durationSec = buffer.duration;

      const startAt = clampFinite(this.state.timeSec, 0, Math.max(0, buffer.duration - 0.0001));

      this.startMusicSource(buffer, startAt, reason);

      this.state.isPlaying = true;
      this.state.lastError = null;

      this.emit("audio:play", { trackId: this.state.activeTrackId });
      this.emitState(reason);
      this.persistPlayer(reason);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.lastError = msg;
      this.emit("audio:play-failed", { reason: "exception", message: msg });
      this.emitState("audio:play-failed");
    }
  }

  pause(reason = "audio:pause"): void {
    if (!this.state.isPlaying) return;

    this.updatePlayheadFromCtxTime();
    this.stopMusicSource("pause");

    this.state.isPlaying = false;
    this.emit("audio:pause", { trackId: this.state.activeTrackId });
    this.emitState(reason);
    this.persistPlayer(reason);
  }

  togglePlay(reason = "audio:toggle"): void {
    if (this.state.isPlaying) this.pause(reason);
    else void this.play(reason);
  }

  seek(timeSec: number, reason = "audio:seek"): void {
    const t = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
    this.state.timeSec = t;

    this.emit("audio:seek", { timeSec: t, trackId: this.state.activeTrackId });
    this.emitState(reason);

    if (this.state.isPlaying) {
      this.updatePlayheadFromCtxTime();
      this.stopMusicSource("seek");
      this.state.isPlaying = false;
      void this.play("audio:seek-restart");
    }

    this.persistPlayer(reason);
  }

  setVolume(volume01: number, reason = "audio:volume"): void {
    const v = clamp01(volume01);
    if (Math.abs(this.state.volume - v) < 0.0001) return;

    this.state.volume = v;
    this.persistence.setAudioPlayer({ volume: v }, reason);

    if (!this.fade.active) {
      this.state.effectiveVolume = this.computeEffectiveVolume();
    }

    this.applyGainsFromState(reason);

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
   * System-level mute/fade.
   *
   * IMPORTANT:
   * - "audio:fade-to-silence" is a REQUEST event (consumed by this system).
   * - Therefore this method must NOT emit "audio:fade-to-silence" again.
   */
  fadeToSilence(reason: AudioFadeReason = "system", durationSec?: number): void {
    const dur = Math.max(0, durationSec ?? this.defaultFadeSec);

    this.prevPlayingBeforeSystemMute = this.state.isPlaying;
    this.state.systemMuted = true;

    if (this.state.isPlaying) this.pause("audio:system-mute");

    this.startFade(this.state.effectiveVolume, 0, dur, reason);

    // Emit ONLY state/diagnostics, not the request event.
    this.emit("audio:fade", { kind: "to-silence", reason, durationSec: dur });
    this.emitState("audio:fade-to-silence");
  }

  /**
   * Release system-level mute/fade.
   *
   * IMPORTANT:
   * - "audio:resume" is a REQUEST event (consumed by this system).
   * - Therefore this method must NOT emit "audio:resume" again.
   */
  resumeSystemAudio(reason: AudioFadeReason = "system", durationSec?: number): void {
    const dur = Math.max(0, durationSec ?? this.defaultFadeSec);

    this.state.systemMuted = false;

    const target = this.computeEffectiveVolume({ ignoreFade: true });
    this.startFade(this.state.effectiveVolume, target, dur, reason);

    if (this.prevPlayingBeforeSystemMute) {
      this.prevPlayingBeforeSystemMute = false;
      void this.play("audio:resume-system-audio");
    }

    // Emit ONLY state/diagnostics, not the request event.
    this.emit("audio:fade", { kind: "resume", reason, durationSec: dur });
    this.emitState("audio:resume");
  }

  // ---------------------------------------------------------------------------
  // Engine lifecycle
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    if (this.state.isPlaying) {
      this.updatePlayheadFromCtxTime();
    }

    if (this.fade.active) {
      const d = Math.max(0.000001, this.fade.duration);
      this.fade.t = clamp01(this.fade.t + Math.max(0, dt) / d);

      const v = lerp(this.fade.from, this.fade.to, this.fade.t);
      this.state.effectiveVolume = clamp01(v);

      if (this.fade.t >= 1) {
        this.fade.active = false;
        this.state.effectiveVolume = this.computeEffectiveVolume();
      }

      this.applyGainsFromState("fade:update");
    }

    // Emit audio:frame for reactive systems (Core, rings, etc.)
    this.maybeEmitAudioFrame("update");
  }

  dispose(): void {
    this.detachBusHandlers();
    this.stopMusicSource("dispose");

    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {}
      this.analyser = null;
    }
    if (this.musicGain) {
      try {
        this.musicGain.disconnect();
      } catch {}
      this.musicGain = null;
    }
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {}
      this.masterGain = null;
    }

    this.decoded.clear();
    this.fftBins = null;

    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {}
      this.audioCtx = null;
    }
  }

  // ---------------------------------------------------------------------------
  // WebAudio internals
  // ---------------------------------------------------------------------------

  private async ensureGraph(): Promise<void> {
    if (!this.state.isUnlocked) return;
    if (!this.audioCtx) return;

    if (this.audioCtx.state !== "running") {
      await this.audioCtx.resume();
      this.state.isUnlocked = this.audioCtx.state === "running";
    }

    if (!this.masterGain) this.buildGraph();
  }

  private buildGraph(): void {
    if (!this.audioCtx) return;
    if (this.masterGain) return;

    const ctx = this.audioCtx;

    this.masterGain = ctx.createGain();
    this.musicGain = ctx.createGain();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Allocate FFT buffer once
    this.fftBins = new Uint8Array(this.analyser.frequencyBinCount);

    this.applyGainsFromState("graph:init");
    this.emit("audio:graph", { reason: "graph:init" });
  }

  private applyGainsFromState(reason: string): void {
    if (!this.audioCtx) return;

    const master = this.safeGain(this.state.effectiveVolume);

    if (this.masterGain) this.masterGain.gain.value = master;
    if (this.musicGain) this.musicGain.gain.value = 1;

    this.emit("audio:graph", { reason, master, ctxState: this.audioCtx.state });
  }

  private async getDecodedBuffer(trackId: string): Promise<AudioBuffer> {
    const cached = this.decoded.get(trackId);
    if (cached) return cached;

    if (!this.audioCtx) throw new Error("AudioContext not ready.");

    const urls = this.getTrackUrlCandidates(trackId);
    let lastErr: unknown = null;

    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const arr = await res.arrayBuffer();

        const audioBuf = await this.decodeArrayBuffer(arr);
        this.decoded.set(trackId, audioBuf);

        this.emit("audio:track-decoded", { trackId, url, durationSec: audioBuf.duration });
        return audioBuf;
      } catch (err) {
        lastErr = err;
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Failed to load track "${trackId}". Tried: ${urls.join(", ")}. Last error: ${msg}`);
  }

  private decodeArrayBuffer(arr: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.audioCtx) return Promise.reject(new Error("AudioContext not ready."));
    const ctx = this.audioCtx;

    return new Promise((resolve, reject) => {
      try {
        const p = ctx.decodeAudioData(arr, resolve, reject);
        if (p && typeof (p as any).then === "function") {
          (p as Promise<AudioBuffer>).then(resolve).catch(reject);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  private startMusicSource(buffer: AudioBuffer, offsetSec: number, reason: string): void {
    if (!this.audioCtx || !this.musicGain) throw new Error("Audio graph not ready.");

    this.stopMusicSource("restart");

    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.musicGain);

    const offset = clampFinite(offsetSec, 0, Math.max(0, buffer.duration - 0.0001));

    this.musicSource = src;
    this.musicStartAtCtxTime = this.audioCtx.currentTime;
    this.musicStartOffsetSec = offset;

    src.onended = () => {
      if (this.musicSource !== src) return;

      this.state.timeSec = buffer.duration;
      this.state.isPlaying = false;
      this.musicSource = null;

      this.emit("audio:ended", { trackId: this.state.activeTrackId });
      this.emitState("audio:ended");
      this.persistPlayer("audio:ended");
    };

    src.start(0, offset);
    this.emit("audio:music-start", { reason, offsetSec: offset, durationSec: buffer.duration });
  }

  private stopMusicSource(reason: string): void {
    if (!this.musicSource) return;

    const src = this.musicSource;
    this.musicSource = null;

    try {
      src.onended = null;
    } catch {}
    try {
      src.stop();
    } catch {}
    try {
      src.disconnect();
    } catch {}

    this.emit("audio:music-stop", { reason });
  }

  private updatePlayheadFromCtxTime(): void {
    if (!this.audioCtx) return;
    if (!this.musicSource) return;

    const elapsed = Math.max(0, this.audioCtx.currentTime - this.musicStartAtCtxTime);
    const t = this.musicStartOffsetSec + elapsed;

    if (Number.isFinite(t)) this.state.timeSec = t;
  }

  private getTrackUrlCandidates(trackId: string): string[] {
    const name = trackId;

    const urls: string[] = [];
    urls.push(`/assets/audio/${name}.mp3`);
    urls.push(`/audio/${name}.mp3`);
    urls.push(`/${name}.mp3`);

    const lower = name.toLowerCase();
    if (lower !== name) {
      urls.push(`/assets/audio/${lower}.mp3`);
      urls.push(`/audio/${lower}.mp3`);
      urls.push(`/${lower}.mp3`);
    }

    return Array.from(new Set(urls));
  }

  // ---------------------------------------------------------------------------
  // Reactive frame emission (FFT -> energy/low/mid/high + onset + peakHold)
  // ---------------------------------------------------------------------------

  private maybeEmitAudioFrame(reason: string): void {
    if (!this.audioCtx) return;
    if (!this.analyser) return;
    if (!this.fftBins) return;
    if (!this.state.isUnlocked) return;

    // Throttle: ~30fps using AudioContext time (stable, monotonic)
    const now = this.audioCtx.currentTime;
    const interval = 1 / Math.max(1, this.frameHz);

    if (this.lastFrameEmitCtxTime >= 0 && now - this.lastFrameEmitCtxTime < interval) return;

    // Capture previous timestamp BEFORE updating
    const prev = this.lastFrameEmitCtxTime >= 0 ? this.lastFrameEmitCtxTime : now - interval;
    this.lastFrameEmitCtxTime = now;

    // Pull frequency-domain data (0..255)
    this.analyser.getByteFrequencyData(this.fftBins);

    const sr = this.audioCtx.sampleRate || 48000;
    const binCount = this.fftBins.length;
    const nyquist = sr * 0.5;
    const hzPerBin = nyquist / Math.max(1, binCount);

    // Bands (Hz). Broad for vibe, not lab precision.
    const lowHz: [number, number] = [40, 250];
    const midHz: [number, number] = [250, 2000];
    const highHz: [number, number] = [2000, 8000];

    const low = this.avgBand01(lowHz[0], lowHz[1], hzPerBin);
    const mid = this.avgBand01(midHz[0], midHz[1], hzPerBin);
    const high = this.avgBand01(highHz[0], highHz[1], hzPerBin);

    // Energy: weighted blend (low carries “pulse”, highs carry “sparkle”)
    const rawEnergy = clamp01(low * 0.30 + mid * 0.60 + high * 0.10);

    // dt in seconds between emitted frames
    const dt = Math.max(0.000001, now - prev);

    // Smooth energy/bands for aesthetics (time-based one-pole)
    const alpha = clamp01(1 - Math.exp(-dt * this.bandSmoothHz));

    this.smoothedLow = lerp(this.smoothedLow, low, alpha);
    this.smoothedMid = lerp(this.smoothedMid, mid, alpha);
    this.smoothedHigh = lerp(this.smoothedHigh, high, alpha);
    this.smoothedEnergy = lerp(this.smoothedEnergy, rawEnergy, alpha);

    // --------------------------------------------------------
    // Onset (note pops)
    // --------------------------------------------------------
    // Positive delta emphasizes attacks; scaled to become meaningful on quiet tracks.
    const delta = Math.max(0, rawEnergy - this.prevRawEnergy);
    this.prevRawEnergy = rawEnergy;

    // Gain + a tiny curve so small deltas still register
    const onsetTarget = clamp01(Math.pow(delta * this.onsetGain, 0.85));

    // Attack/Release envelope (fast attack, quick-ish release)
    this.smoothedOnset = smoothAR(this.smoothedOnset, onsetTarget, this.onsetAttackHz, this.onsetReleaseHz, dt);

    // --------------------------------------------------------
    // Peak hold (for "fill the ring" moments)
    // --------------------------------------------------------
    // - instantly catches big peaks
    // - decays slowly so visuals can "arrive" and linger
    if (rawEnergy >= this.peakHold) {
      this.peakHold = rawEnergy;
    } else {
      this.peakHold = Math.max(rawEnergy, this.peakHold - this.peakDecayPerSec * dt);
    }
    this.peakHold = clamp01(this.peakHold);

    this.emit("audio:frame", {
      reason,
      frame: {
        energy: clamp01(this.smoothedEnergy),
        low: clamp01(this.smoothedLow),
        mid: clamp01(this.smoothedMid),
        high: clamp01(this.smoothedHigh),
        onset: clamp01(this.smoothedOnset),
        peak: this.peakHold,
      },
      isPlaying: this.state.isPlaying,
      trackId: this.state.activeTrackId,
      atCtxTime: now,
    });
  }

  private avgBand01(hzLo: number, hzHi: number, hzPerBin: number): number {
    if (!this.fftBins) return 0;

    const lo = Math.max(0, Math.floor(hzLo / Math.max(0.000001, hzPerBin)));
    const hi = Math.min(this.fftBins.length - 1, Math.ceil(hzHi / Math.max(0.000001, hzPerBin)));

    if (hi <= lo) return 0;

    let sum = 0;
    let count = 0;

    for (let i = lo; i <= hi; i++) {
      sum += this.fftBins[i] ?? 0;
      count++;
    }

    const avg = count > 0 ? sum / count : 0;
    return clamp01(avg / 255);
  }

  // ---------------------------------------------------------------------------
  // EventBus wiring
  // ---------------------------------------------------------------------------

  private attachBusHandlers(): void {
    this.bind("audio:unlock-request", () => {
      void this.unlock("audio:unlock-request");
    });

    this.bind("audio:announce", () => this.announceState("audio:announce"));

    this.bind("audio:set-track", (p: { trackId: string | null }) => this.setTrack(p?.trackId ?? null, "audio:set-track"));
    this.bind("audio:play-request", () => {
      void this.play("audio:play-request");
    });
    this.bind("audio:pause-request", () => this.pause("audio:pause-request"));
    this.bind("audio:toggle-request", () => this.togglePlay("audio:toggle-request"));
    this.bind("audio:seek", (p: { timeSec: number }) => this.seek(p?.timeSec ?? 0, "audio:seek"));

    this.bind("audio:seek-nudge", (p: { deltaSec: number }) => {
      const d = Number.isFinite(p?.deltaSec) ? p.deltaSec : 0;
      this.seek(this.state.timeSec + d, "audio:seek-nudge");
    });

    this.bind("audio:set-volume", (p: { volume: number }) =>
      this.setVolume(p?.volume ?? this.state.volume, "audio:set-volume"),
    );
    this.bind("audio:volume-nudge", (p: { delta: number }) => {
      const d = Number.isFinite(p?.delta) ? p.delta : 0;
      this.setVolume(this.state.volume + d, "audio:volume-nudge");
    });

    this.bind("audio:set-shuffle", (p: { shuffle: boolean }) => this.setShuffle(!!p?.shuffle, "audio:set-shuffle"));
    this.bind("audio:set-repeat", (p: { repeat: RepeatMode }) => this.setRepeat(p?.repeat ?? this.state.repeat, "audio:set-repeat"));

    // REQUEST events (do NOT re-emit from within the handler chain)
    this.bind("audio:fade-to-silence", (p: { reason?: AudioFadeReason; durationSec?: number }) =>
      this.fadeToSilence(p?.reason ?? "system", p?.durationSec),
    );

    // REQUEST event (do NOT re-emit from within the handler chain)
    this.bind("audio:resume", (p: { reason?: AudioFadeReason; durationSec?: number }) =>
      this.resumeSystemAudio(p?.reason ?? "system", p?.durationSec),
    );

    // Gate drives requests
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

  private persistPlayer(reason: string): void {
    this.persistence?.setAudioPlayer?.(
      {
        activeTrackId: this.state.activeTrackId,
        isPlaying: this.state.isPlaying,
        timeSec: this.state.timeSec,
        durationSec: this.state.durationSec,
        shuffle: this.state.shuffle,
        repeat: this.state.repeat,
        volume: this.state.volume,
      },
      reason,
    );
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
      this.applyGainsFromState("fade:instant");
    }
  }

  private computeEffectiveVolume(opts?: { ignoreFade?: boolean }): number {
    if (this.state.systemMuted) return 0;
    if (!opts?.ignoreFade && this.fade.active) return this.state.effectiveVolume;
    return clamp01(this.state.volume);
  }

  private safeGain(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return clamp01(v);
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const clampFinite = (v: number, lo: number, hi: number): number => {
  if (!Number.isFinite(v)) return lo;
  if (hi <= lo) return lo;
  return Math.min(hi, Math.max(lo, v));
};

/**
 * Attack/Release smoother:
 * - If target is above current -> attack rate
 * - If target is below current -> release rate
 * rates are in "Hz" (higher = faster)
 */
const smoothAR = (current: number, target: number, attackHz: number, releaseHz: number, dt: number): number => {
  const a = Math.max(0, attackHz);
  const r = Math.max(0, releaseHz);
  const rate = target > current ? a : r;

  if (rate <= 0) return target;

  const k = 1 - Math.exp(-rate * Math.max(0.000001, dt));
  const out = current + (target - current) * k;
  return Number.isFinite(out) ? out : target;
};
