// src/systems/harmony/HarmonyAmbientSystem.ts
// ============================================================
// THE STILL — HarmonyAmbientSystem (Phase 1)
//  - Listens to canonical harmony:environment:* snapshots
//  - Turns ambient toggles into Howler ambient loop commands
//  - On dispose, cleanly disables any active ambients (HMR-safe)
// ============================================================

import type { EventBus } from "../../core/EventBus";

type AnyFn = (...args: any[]) => void;

type HarmonyEnvironmentStateEvent = {
  // HarmonyEnvironmentSystem emits BOTH:
  // - flattened: { ambients }
  // - nested: { environment: { ambients } }
  ambients?: Record<string, boolean>;
  environment?: {
    ambients?: Record<string, boolean>;
  };
  reason?: string;
};

const AMBIENT_URLS: Record<string, string> = {
  crickets: "/assets/audio/ambient/crickets.mp3",
  wind: "/assets/audio/ambient/wind.mp3",
  waves: "/assets/audio/ambient/waves.mp3",
  chimes: "/assets/audio/ambient/chimes.mp3",
};

export class HarmonyAmbientSystem {
  private readonly bus: EventBus;
  private disposers: Array<() => void> = [];
  private initialized = false;

  private last: Record<string, boolean> = {};

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.on("harmony:environment:state", (p: HarmonyEnvironmentStateEvent) => this.applyFromEvent(p));
    this.on("harmony:environment:changed", (p: HarmonyEnvironmentStateEvent) => this.applyFromEvent(p));
  }

  dispose(): void {
    // HMR-safe cleanup: explicitly disable any loops we enabled.
    for (const [id, enabled] of Object.entries(this.last)) {
      if (!enabled) continue;

      const url = AMBIENT_URLS[id];
      if (!url) continue;

      this.bus.emit("howler:ambient:set", {
        id,
        url,
        enabled: false,
        source: "harmony-ambient:dispose",
      });
    }

    this.last = {};

    for (const d of this.disposers) d();
    this.disposers = [];
    this.initialized = false;
  }

  private applyFromEvent(p: HarmonyEnvironmentStateEvent): void {
    const ambients = (p?.ambients ?? p?.environment?.ambients ?? {}) as Record<string, boolean>;
    if (!ambients || typeof ambients !== "object") return;

    // diff-based apply
    const keys = new Set<string>([...Object.keys(this.last), ...Object.keys(ambients)]);

    for (const id of keys) {
      const enabled = Boolean(ambients[id]);
      const prev = Boolean(this.last[id]);
      if (enabled === prev) continue;

      const url = AMBIENT_URLS[id];
      if (!url) continue;

      this.bus.emit("howler:ambient:set", {
        id,
        url,
        enabled,
        source: "harmony-ambient:env",
        reason: String(p?.reason ?? "env"),
      });
    }

    // Keep a normalized copy (booleans only)
    const next: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(ambients)) next[k] = Boolean(v);
    this.last = next;
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}