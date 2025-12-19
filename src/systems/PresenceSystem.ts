// src/systems/PresenceSystem.ts
// P04 - Presence System Core

import * as THREE from "three";

type PresenceState = {
  level: number;      // 0.0 (absent) to 1.0 (fully present)
  lastUpdate: number; // Timestamp of last state change
};

export type ClockPresenceLevels = {
  hour: number;
  minute: number;
  second: number;
};

export type PresenceGatesConfig = {
  /**
   * Staged fade timeline in seconds.
   * As presence drops from 1 -> 0, we treat it like progressing through:
   *   Hour fade window   (default 60s)
   *   Minute fade window (default 30s)
   *   Second fade window (default 15s)
   *
   * Hour fades away first, then Minute, then Second.
   */
  hourFadeSeconds: number;
  minuteFadeSeconds: number;
  secondFadeSeconds: number;

  /**
   * Easing strength for fades.
   * 0 = linear
   * 1 = smoother (default)
   * 2 = even smoother
   */
  easePower: number;
};

export class PresenceSystem {
  private state: PresenceState;

  // Optional debug hotkeys cleanup
  private debugKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  private gates: PresenceGatesConfig = {
    hourFadeSeconds: 60,
    minuteFadeSeconds: 30,
    secondFadeSeconds: 15,
    easePower: 1,
  };

  constructor() {
    this.state = {
      level: 0.0,
      lastUpdate: performance.now(),
    };
  }

  update(deltaTime: number): void {
    // NOT YET: Dynamic calculations based on input or world state
    // deltaTime is in seconds in your Engine update flow (based on your other systems)
    void deltaTime;

    this.state.lastUpdate = performance.now();
  }

  getPresenceLevel(): number {
    return this.state.level;
  }

  setPresenceLevel(level: number): void {
    this.state.level = THREE.MathUtils.clamp(level, 0, 1);
    this.state.lastUpdate = performance.now();
  }

  nudgePresence(delta: number): void {
    this.setPresenceLevel(this.state.level + delta);
  }

  // ---------------------------------------------------------------------------
  // Gates / staged clock presence
  // ---------------------------------------------------------------------------

  /**
   * Configure the staged fade timeline.
   * Defaults: 60 / 30 / 15 (hour, minute, second).
   */
  setGatesConfig(partial: Partial<PresenceGatesConfig>): void {
    this.gates = {
      ...this.gates,
      ...partial,
    };

    // Safety clamps
    this.gates.hourFadeSeconds = Math.max(0.001, this.gates.hourFadeSeconds);
    this.gates.minuteFadeSeconds = Math.max(0.001, this.gates.minuteFadeSeconds);
    this.gates.secondFadeSeconds = Math.max(0.001, this.gates.secondFadeSeconds);
    this.gates.easePower = Math.max(0, this.gates.easePower);
  }

  getGatesConfig(): PresenceGatesConfig {
    return { ...this.gates };
  }

  /**
   * Returns staged presence values for the clock rings.
   * These are meant to be fed directly into ClockSystem per-ring tail length.
   *
   * Behavior:
   * - As global presence falls from 1 -> 0, the "fade progress" moves through
   *   three sequential windows (hour, minute, second).
   * - Hour diminishes first, then minute, then second.
   */
  getClockPresenceLevels(): ClockPresenceLevels {
    const p = THREE.MathUtils.clamp(this.state.level, 0, 1);

    const { hourFadeSeconds, minuteFadeSeconds, secondFadeSeconds } = this.gates;
    const total = hourFadeSeconds + minuteFadeSeconds + secondFadeSeconds;

    // Convert presence into "fade progress seconds" through the whole timeline.
    // presence 1.0 => 0s progressed (fully visible)
    // presence 0.0 => total seconds progressed (fully gone)
    const progressed = (1 - p) * total;

    const hour = this.computeStageValue(progressed, 0, hourFadeSeconds);
    const minute = this.computeStageValue(progressed, hourFadeSeconds, minuteFadeSeconds);
    const second = this.computeStageValue(progressed, hourFadeSeconds + minuteFadeSeconds, secondFadeSeconds);

    return { hour, minute, second };
  }

  getHourPresence(): number {
    return this.getClockPresenceLevels().hour;
  }

  getMinutePresence(): number {
    return this.getClockPresenceLevels().minute;
  }

  getSecondPresence(): number {
    return this.getClockPresenceLevels().second;
  }

  /**
   * Stage value is 1 at the start of its window, and falls to 0 across its window.
   * Before the window begins: 1
   * After the window ends: 0
   */
  private computeStageValue(progressedSeconds: number, stageStart: number, stageDuration: number): number {
    const t = (progressedSeconds - stageStart) / stageDuration;

    // Before the stage begins: fully present
    if (t <= 0) return 1;

    // After the stage ends: gone
    if (t >= 1) return 0;

    // Within stage: fade from 1 -> 0
    const linear = 1 - t;

    // Optional easing: raise to a power for a smoother feel
    const eased = this.gates.easePower <= 0 ? linear : Math.pow(linear, 1 + this.gates.easePower);

    return THREE.MathUtils.clamp(eased, 0, 1);
  }

  /**
   * Dev helper: Press:
   *  - [ / ] to nudge down/up
   *  - \ to snap to 1.0
   *  - ' to snap to 0.0
   */
  enableDebugHotkeys(target: Window | HTMLElement = window): void {
    if (this.debugKeyHandler) return;

    this.debugKeyHandler = (e: KeyboardEvent) => {
      // Avoid stealing input while typing
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.key === "[") this.nudgePresence(-0.05);
      if (e.key === "]") this.nudgePresence(0.05);
      if (e.key === "\\") this.setPresenceLevel(1.0);
      if (e.key === "'") this.setPresenceLevel(0.0);
    };

    target.addEventListener("keydown", this.debugKeyHandler as any);
  }

  disableDebugHotkeys(target: Window | HTMLElement = window): void {
    if (!this.debugKeyHandler) return;
    target.removeEventListener("keydown", this.debugKeyHandler as any);
    this.debugKeyHandler = null;
  }

  /**
   * Dev helper: exposes presence controls in the console as __presence
   */
  devExposeToWindow(): void {
    (window as any).__presence = this;
  }

  // NOT YET: Reactive hooks for other systems (e.g., onChange)
  // NOT YET: Integration with fog, accretion logic, multi-source blending
}
