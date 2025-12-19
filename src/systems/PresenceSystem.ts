// src/systems/PresenceSystem.ts
// P04 - Presence System Core

import * as THREE from "three";

type PresenceState = {
  level: number;      // 0.0 (absent) to 1.0 (fully present)
  lastUpdate: number; // Timestamp of last state change
};

export class PresenceSystem {
  private state: PresenceState;

  // Optional debug hotkeys cleanup
  private debugKeyHandler: ((e: KeyboardEvent) => void) | null = null;

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
