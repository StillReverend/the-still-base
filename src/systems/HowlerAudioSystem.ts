// src/systems/HowlerAudioSystem.ts
// ============================================================
// THE STILL — HowlerAudioSystem (Playback-first)
// ------------------------------------------------------------
// Responsibilities:
//  - Reliable playback for SFX + Ambient (later: music playback too)
//  - Listens to "audio:unlock-request" to unlock mobile audio
//  - Listens to UI events ("ui:hover", "ui:click") for proof
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

type UiSfxPayload = { kind?: "hover" | "click" };

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
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class HowlerAudioSystem {
  private readonly bus: EventBus;
  private readonly basePath: string;

  private state: HowlerAudioState;

  private howls = new Map<string, Howl>();

  private unlockAttempted = false;

  private readonly UI_HOVER_ID = "ui:hover";
  private readonly UI_CLICK_ID = "ui:click";

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

    // Proof hooks:
    this.bus.on<UiSfxPayload>("ui:hover", this.onUiHover);
    this.bus.on<UiSfxPayload>("ui:click", this.onUiClick);
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
  }

  setMasterVolume(value01: number): void {
    this.state.master = clamp01(value01);
    Howler.volume(this.state.master);
  }

  dispose(): void {
    this.bus.off("audio:unlock-request", this.onUnlockRequest);
    this.bus.off("ui:hover", this.onUiHover);
    this.bus.off("ui:click", this.onUiClick);

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

  private onUnlockRequest = (): void => {
    if (this.unlockAttempted) return;
    this.unlockAttempted = true;

    // Resume Howler's AudioContext if available
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
        html5: false,
      });
      const id = unlockHowl.play();
      unlockHowl.stop(id);
      unlockHowl.unload();
    } catch {
      // ignore
    }

    this.state.isUnlocked = true;

    // We intentionally do NOT emit "audio:unlocked" to avoid conflicting with AudioSystem.
    this.bus.emit("howler:unlocked", {});
  };

  // ---------------------------------------------------------------------------
  // Proof UI sounds
  // ---------------------------------------------------------------------------

  private onUiHover = (): void => {
    const url = `${this.basePath}/ui/hover.mp3`;
    this.playSfx(this.UI_HOVER_ID, url, this.state.sfx);
  };

  private onUiClick = (): void => {
    const url = `${this.basePath}/ui/click.mp3`;
    this.playSfx(this.UI_CLICK_ID, url, this.state.sfx);
  };

  private playSfx(id: string, url: string, volume01: number): void {
    if (this.state.isMuted) return;
    if (!this.state.isUnlocked) return;

    const vol = clamp01(volume01);
    const howl = this.getOrCreateHowl(id, url, { loop: false, volume: vol });
    howl.volume(vol);
    howl.play();
  }

  private getOrCreateHowl(
    id: string,
    url: string,
    opts: { loop: boolean; volume: number },
  ): Howl {
    const existing = this.howls.get(id);
    if (existing) return existing;

    const howl = new Howl({
      src: [url],
      loop: opts.loop,
      volume: clamp01(opts.volume),
      preload: true,
      html5: false,
    });

    this.howls.set(id, howl);
    return howl;
  }
}
