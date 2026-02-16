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
//  - Resolve media URLs via MediaResolverSystem (EventBus request/response)
//  - Load + play via fetch + decodeAudioData
//  - Play/Pause/Seek/Volume; emits audio:state + diagnostics
//
// Notes:
//  - IMPORTANT ARCH RULE:
//      "audio:fade-to-silence" and "audio:resume" are *REQUEST* events.
//      AudioSystem must NEVER emit them, or it can recurse through its own handlers.
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PersistenceSystem, RepeatMode } from "./PersistenceSystem";

// ✅ Single canonical contract for audio:state payload.state
// (Harmony consumes this via EventBus only; no runtime coupling required.)
import type { AudioSystemState } from "./harmony/types";

import { getAllTracks } from "./harmony/TrackCatalog";

export type AudioFadeReason = "gate" | "user" | "system";

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

type MediaPurpose = "decode" | "duration";

type MediaResolveResultPayload = {
  requestId: string;
  trackId: string;
  ok: boolean;
  urls?: string[];
  error?: string;
};

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

  // prevent duplicate preloads
  private durationPreloadInFlight: Promise<void> | null = null;

  private musicSource: AudioBufferSourceNode | null = null;
  private musicStartAtCtxTime = 0; // ctx.currentTime at start()
  private musicStartOffsetSec = 0; // offset passed into start()

  // keep reference to the current decoded buffer so we can live-seek while playing
  private currentMusicBuffer: AudioBuffer | null = null;

  // ----------------------------------------------------------
  // Media Resolver (EventBus request/response)
  // ----------------------------------------------------------

  private mediaReqSeq = 0;

  private pendingMedia = new Map<
    string,
    {
      resolve: (urls: string[]) => void;
      reject: (err: Error) => void;
      trackId: string;
      purpose: MediaPurpose;
      timeoutId: number;
    }
  >();

  // ----------------------------------------------------------
  // Audio frame (FFT -> bands) for reactive systems
  // ----------------------------------------------------------

  private fftBins: Uint8Array | null = null;

  // Throttle bus emissions to avoid log spam.
  private readonly frameHz = 20;
  private lastFrameEmitCtxTime = -1;

  // Throttle "audio:state" emissions while playing (UI sync)
  private readonly stateHz = 6;
  private lastStateEmitCtxTime = -1;

  // Smoothed bands (0..1).
  private smoothedEnergy = 0;
  private smoothedLow = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;

  // "note pop" onset (0..1)
  private smoothedOnset = 0;
  private prevRawEnergy = 0;

  // onset tuning
  private readonly onsetGain = 14; // try 10..22
  private readonly onsetAttackHz = 80; // try 60..140
  private readonly onsetReleaseHz = 16; // try 10..28

  // Existing smoothing speed for bands/energy
  private readonly bandSmoothHz = 10;

  // peak hold (0..1) for "big moment" visuals.
  private peakHold = 0;
  private readonly peakDecayPerSec = 0.42;

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
      // If we have an active track, preload its duration so UI can show it before Play.
      if (this.state.activeTrackId) {
        this.preloadDurationFor(this.state.activeTrackId, "audio:duration-preload-after-unlock");
      }
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

    // Preload duration for the newly selected track if we're unlocked.
    if (trackId) {
      this.preloadDurationFor(trackId, "audio:duration-preload-after-setTrack");
    }

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

    // Update state immediately to requested value.
    this.state.timeSec = t;

    // If we're playing and we already have the decoded buffer, do a true live seek:
    if (this.state.isPlaying && this.audioCtx && this.musicGain && this.currentMusicBuffer) {
      const buffer = this.currentMusicBuffer;
      const safeT = clampFinite(t, 0, Math.max(0, buffer.duration - 0.0001));

      // Keep duration consistent
      if (
        this.state.durationSec == null ||
        !Number.isFinite(this.state.durationSec) ||
        this.state.durationSec <= 0
      ) {
        this.state.durationSec = buffer.duration;
      }

      // Restart at the requested offset
      this.startMusicSource(buffer, safeT, reason, "seek");

      // Still playing
      this.state.isPlaying = true;

      this.emit("audio:seek", { timeSec: safeT, trackId: this.state.activeTrackId });
      this.emitState(reason);
      this.persistPlayer(reason);
      return;
    }

    // Not playing (or buffer not ready): just update playhead so next Play starts here.
    this.emit("audio:seek", { timeSec: t, trackId: this.state.activeTrackId });
    this.emitState(reason);
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

      // Emit audio:state periodically so Harmony UI time advances.
      // Uses AudioContext time for stable throttling.
      if (this.audioCtx) {
        const now = this.audioCtx.currentTime;
        const interval = 1 / Math.max(1, this.stateHz);

        if (this.lastStateEmitCtxTime < 0 || now - this.lastStateEmitCtxTime >= interval) {
          this.lastStateEmitCtxTime = now;
          this.emitState("audio:tick");
        }
      }
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
    // Cancel any pending media resolves
    for (const [id, p] of this.pendingMedia.entries()) {
      try {
        window.clearTimeout(p.timeoutId);
      } catch {}
      try {
        p.reject(new Error("AudioSystem disposed."));
      } catch {}
      this.pendingMedia.delete(id);
    }

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
    this.currentMusicBuffer = null;

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

  private resolveMediaUrls(trackId: string, purpose: MediaPurpose): Promise<string[]> {
    const requestId = `m${Date.now()}_${++this.mediaReqSeq}_${trackId}`;

    return new Promise((resolve, reject) => {
      const timeoutMs = 6000;

      const timeoutId = window.setTimeout(() => {
        this.pendingMedia.delete(requestId);
        reject(new Error(`Media resolve timed out for "${trackId}".`));
      }, timeoutMs);

      this.pendingMedia.set(requestId, { resolve, reject, trackId, purpose, timeoutId });

      this.emit("media:resolve", { requestId, trackId, purpose });
    });
  }

  private async getDecodedBuffer(trackId: string): Promise<AudioBuffer> {
    const cached = this.decoded.get(trackId);
    if (cached) return cached;

    if (!this.audioCtx) throw new Error("AudioContext not ready.");

    const urls = await this.resolveMediaUrls(trackId, "decode");
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

  // ---------------------------------------------------------------------------
  // Duration preload (no autoplay)
  // ---------------------------------------------------------------------------

  private preloadDurationFor(trackId: string, reason: string): void {
    if (!trackId) return;
    if (!this.state.isUnlocked) return; // wait until unlocked
    if (this.durationPreloadInFlight) return;

    this.durationPreloadInFlight = (async () => {
      try {
        await this.ensureGraph(); // safe; won’t start playback

        // Prefer a lightweight "duration" resolve, even though DEV currently returns the same URLs.
        // This future-proofs signed URLs / analytics without changing AudioSystem later.
        const urls = await this.resolveMediaUrls(trackId, "duration");

        // If decode cache already has it, use it.
        const cached = this.decoded.get(trackId);
        const buf = cached ?? (await this.tryDecodeFirstWorkingUrl(trackId, urls));

        if (!buf) return;

        // Only apply if still the active track
        if (this.state.activeTrackId !== trackId) return;

        const dur = buf.duration;
        if (Number.isFinite(dur) && dur > 0) {
          this.state.durationSec = dur;
          this.persistence.setAudioPlayer({ durationSec: dur }, "audio:duration-preload");
          this.emitState(reason);
        }
      } catch {
        // If preload fails, we’ll still get duration on Play.
      } finally {
        this.durationPreloadInFlight = null;
      }
    })();
  }

  private async tryDecodeFirstWorkingUrl(trackId: string, urls: string[]): Promise<AudioBuffer | null> {
    if (!this.audioCtx) return null;

    let lastErr: unknown = null;

    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const arr = await res.arrayBuffer();

        const audioBuf = await this.decodeArrayBuffer(arr);
        this.decoded.set(trackId, audioBuf);

        this.emit("audio:track-decoded", { trackId, url, durationSec: audioBuf.duration, purpose: "duration" });
        return audioBuf;
      } catch (err) {
        lastErr = err;
      }
    }

    // Don’t throw for duration preload; just emit a soft diagnostic.
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    this.emit("audio:duration-preload-failed", { trackId, message: msg });
    return null;
  }

  private decodeArrayBuffer(arr: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.audioCtx) return Promise.reject(new Error("AudioContext not ready."));
    const ctx = this.audioCtx;

    // ✅ FIX: Avoid double-resolve on browsers where decodeAudioData returns a Promise
    // but also accepts callbacks (Safari/WebKit edge cases).
    try {
      const maybePromise = (ctx.decodeAudioData as unknown as (buffer: ArrayBuffer) => Promise<AudioBuffer>)(arr);
      if (maybePromise && typeof (maybePromise as any).then === "function") {
        return maybePromise;
      }
    } catch {
      // fall through to callback style
    }

    return new Promise((resolve, reject) => {
      try {
        ctx.decodeAudioData(arr, resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Track end + repeat behavior
  // ---------------------------------------------------------------------------

  private handleMusicEnded(endedBuffer: AudioBuffer): void {
    // Mark ended
    this.state.timeSec = endedBuffer.duration;
    this.state.isPlaying = false;
    this.musicSource = null;

    this.emit("audio:ended", { trackId: this.state.activeTrackId });
    this.emitState("audio:ended");
    this.persistPlayer("audio:ended");

    // Repeat behavior
    if (this.state.systemMuted) return;
    if (!this.state.isUnlocked) return;
    if (!this.state.activeTrackId) return;

    // Repeat One: loop the same buffer
    if (this.state.repeat === "one") {
      try {
        this.state.timeSec = 0;
        this.startMusicSource(endedBuffer, 0, "audio:repeat-one");
        this.state.isPlaying = true;

        this.emit("audio:repeat", { mode: "one", trackId: this.state.activeTrackId });
        this.emitState("audio:repeat-one");
        this.persistPlayer("audio:repeat-one");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.lastError = msg;
        this.emit("audio:repeat-failed", { message: msg });
        this.emitState("audio:repeat-failed");
      }
      return;
    }

    // Repeat All: advance through TrackCatalog order (or shuffle) across UNLOCKED songs
    if (this.state.repeat === "all") {
      const currentId = this.state.activeTrackId;
      const nextId = this.pickNextTrackId(currentId);

      if (!nextId) return;

      try {
        // If only one playable track exists, this behaves like looping.
        this.setTrackSilently(nextId, "audio:repeat-all-next");
        awaitableVoid(this.play("audio:repeat-all-next"));

        this.emit("audio:repeat", { mode: "all", from: currentId, to: nextId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.lastError = msg;
        this.emit("audio:repeat-failed", { message: msg });
        this.emitState("audio:repeat-failed");
      }
      return;
    }

    // Repeat Off: do nothing
    return;
  }

  private startMusicSource(
    buffer: AudioBuffer,
    offsetSec: number,
    reason: string,
    stopReason: string = "restart",
  ): void {
    if (!this.audioCtx || !this.musicGain) throw new Error("Audio graph not ready.");

    this.stopMusicSource(stopReason);

    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.musicGain);

    const offset = clampFinite(offsetSec, 0, Math.max(0, buffer.duration - 0.0001));

    this.musicSource = src;
    this.currentMusicBuffer = buffer;
    this.musicStartAtCtxTime = this.audioCtx.currentTime;
    this.musicStartOffsetSec = offset;

    src.onended = () => {
      if (this.musicSource !== src) return;
      this.handleMusicEnded(buffer);
    };

    src.start(0, offset);
    this.emit("audio:music-start", { reason, offsetSec: offset, durationSec: buffer.duration });
  }

  private stopMusicSource(reason: string): void {
    if (!this.musicSource) return;

    const src = this.musicSource;
    this.musicSource = null;
    this.currentMusicBuffer = null;

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

  // ---------------------------------------------------------------------------
  // Reactive frame emission (FFT -> energy/low/mid/high + onset + peakHold)
  // ---------------------------------------------------------------------------

  private maybeEmitAudioFrame(reason: string): void {
    if (!this.audioCtx) return;
    if (!this.analyser) return;
    if (!this.fftBins) return;
    if (!this.state.isUnlocked) return;

    // Throttle using AudioContext time (stable, monotonic)
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

    // Onset (note pops)
    const delta = Math.max(0, rawEnergy - this.prevRawEnergy);
    this.prevRawEnergy = rawEnergy;

    const onsetTarget = clamp01(Math.pow(delta * this.onsetGain, 0.85));
    this.smoothedOnset = smoothAR(
      this.smoothedOnset,
      onsetTarget,
      this.onsetAttackHz,
      this.onsetReleaseHz,
      dt,
    );

    // Peak hold
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

    this.bind("audio:set-track", (p: { trackId: string | null }) =>
      this.setTrack(p?.trackId ?? null, "audio:set-track"),
    );
    this.bind("audio:play-request", () => {
      void this.play("audio:play-request");
    });
    this.bind("audio:pause-request", () => this.pause("audio:pause-request"));
    this.bind("audio:toggle-request", () => this.togglePlay("audio:toggle-request"));
    this.bind("audio:seek-request", (p: { timeSec: number }) => this.seek(p?.timeSec ?? 0, "audio:seek-request"));

    // Media resolver response
    this.bind("media:resolve:result", (p: MediaResolveResultPayload) => this.handleMediaResolveResult(p));

    // Harmony UI commands (audio:cmd:*)
    this.bind("audio:cmd:togglePlay", () => this.togglePlay("audio:cmd:togglePlay"));

    this.bind("audio:cmd:play", () => {
      void this.play("audio:cmd:play");
    });

    this.bind("audio:cmd:pause", () => this.pause("audio:cmd:pause"));

    this.bind("audio:cmd:seek", (p: { timeSec: number }) => {
      this.seek(p?.timeSec ?? 0, "audio:cmd:seek");
    });

    this.bind("audio:cmd:selectTrack", (p: { trackId: string }) => {
      const id = typeof p?.trackId === "string" ? p.trackId : null;
      this.setTrack(id, "audio:cmd:selectTrack");
    });

    this.bind("audio:cmd:setRepeatMode", (p: { mode: RepeatMode }) => {
      this.setRepeat(p?.mode ?? this.state.repeat, "audio:cmd:setRepeatMode");
    });

    // Scaffold: favorites not implemented in AudioSystem yet.
    this.bind("audio:cmd:toggleFavorite", (_p: { trackId: string }) => {
      // TODO (Harmony Phase 1.5): wire to PersistenceSystem favorites store
    });

    this.bind("audio:set-volume", (p: { volume: number }) =>
      this.setVolume(p?.volume ?? this.state.volume, "audio:set-volume"),
    );

    this.bind("audio:volume-nudge", (p: { delta: number }) => {
      const d = Number.isFinite(p?.delta) ? p.delta : 0;
      this.setVolume(this.state.volume + d, "audio:volume-nudge");
    });

    this.bind("audio:set-shuffle", (p: { shuffle: boolean }) => this.setShuffle(!!p?.shuffle, "audio:set-shuffle"));

    this.bind("audio:set-repeat", (p: { repeat: RepeatMode }) =>
      this.setRepeat(p?.repeat ?? this.state.repeat, "audio:set-repeat"),
    );

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

  private handleMediaResolveResult(p: MediaResolveResultPayload): void {
    const requestId = typeof p?.requestId === "string" ? p.requestId : "";
    if (!requestId) return;

    const pending = this.pendingMedia.get(requestId);
    if (!pending) return;

    this.pendingMedia.delete(requestId);
    try {
      window.clearTimeout(pending.timeoutId);
    } catch {}

    if (p.ok && Array.isArray(p.urls) && p.urls.length > 0) {
      pending.resolve(p.urls);
    } else {
      const msg = typeof p?.error === "string" && p.error ? p.error : `Failed to resolve media for "${pending.trackId}".`;
      pending.reject(new Error(msg));
    }
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
  // Repeat-All + Playlist semantics (TrackCatalog order)
  // ---------------------------------------------------------------------------

  private getPlayableTrackIds(kind: "song" | "podcast" | "hidden" | "any" = "song"): string[] {
    const user = this.persistence.getState();

    return getAllTracks()
      .filter((t) => (kind === "any" ? true : t.kind === kind))
      .filter((t) => {
        const existing = user.tracks?.[t.id];
        const unlocked = Boolean(existing?.unlocked) || Boolean(t.defaultUnlocked);
        return unlocked;
      })
      .map((t) => t.id);
  }

  private pickNextTrackId(currentId: string): string | null {
    const playable = this.getPlayableTrackIds("song");

    if (playable.length === 0) return null;
    if (playable.length === 1) return playable[0] ?? null;

    if (this.state.shuffle) {
      const options = playable.filter((id) => id !== currentId);
      const pool = options.length > 0 ? options : playable;
      const idx = Math.floor(Math.random() * pool.length);
      return pool[idx] ?? null;
    }

    const idx = playable.indexOf(currentId);
    if (idx < 0) return playable[0] ?? null;

    const next = playable[(idx + 1) % playable.length];
    return next ?? null;
  }

  private setTrackSilently(trackId: string | null, reason: string): void {
    this.state.activeTrackId = trackId;
    this.state.timeSec = 0;
    this.state.durationSec = null;

    this.persistence.setAudioPlayer({ activeTrackId: trackId, timeSec: 0, durationSec: null }, reason);

    // Keep UI/state in sync without emitting the "audio:set-track" event (avoids echo loops).
    this.emitState(reason);

    if (trackId) {
      this.preloadDurationFor(trackId, `${reason}:duration-preload`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private emit(event: string, payload: unknown): void {
    this.bus.emit(event, payload);
  }

  // ✅ Contract locked: ONLY { state, reason }
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

const awaitableVoid = (p: Promise<unknown>): void => {
  void p;
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
