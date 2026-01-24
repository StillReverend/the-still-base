// src/systems/GateSystem.ts
// ============================================================
// THE STILL — Phase 1
// GateSystem (local wall-clock)
// ------------------------------------------------------------
// Responsibilities:
//  - Enforce daily closure at user's local midnight (wall-clock)
//  - Persist gate status via PersistenceSystem (canonical UserState)
//  - Emit events for other systems to respond:
//      gate:closing, gate:closed, gate:opening, gate:opened
//      core:force-black-hole (requested)
//      audio:fade-to-silence (requested)
//      harmony:resume (requested)
//  - Reopen only after the Core ritual is completed
//
// Notes:
//  - Engine-level system only: no scene-owned state.
//  - We do NOT use TimeSystem (world-time stub). We use local wall-clock Date().
//  - Actual Core/Audo/Harmony enforcement is event-driven and can be wired
//    additively in the relevant systems.
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PersistenceSystem, GateState } from "./PersistenceSystem";

export interface GateSystemOptions {
  /** How often we check for local date rollover (ms). Default 30s. */
  pollIntervalMs?: number;
  /** Event name the ritual system will emit upon completion. Default: "ritual:core:completed" */
  ritualCompleteEvent?: string;
  /** If true, GateSystem will close immediately when started if the persisted state is closed. Default true. */
  enforceOnBoot?: boolean;
}

export interface GateClosingPayload {
  reason: "midnight" | "boot-enforce" | "manual";
  atMs: number;
}

export interface GateOpeningPayload {
  reason: "ritual" | "manual";
  atMs: number;
}

const nowMs = (): number => Date.now();

const localDateKey = (d: Date): string => {
  // "Thu Jan 23 2026" (local)
  // We use toDateString() because it is stable for local day boundary detection.
  return d.toDateString();
};

export class GateSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;

  private readonly pollIntervalMs: number;
  private readonly ritualCompleteEvent: string;
  private readonly enforceOnBoot: boolean;

  private accumulator = 0;
  private lastDateKey: string;

  constructor(bus: EventBus, persistence: PersistenceSystem, opts: GateSystemOptions = {}) {
    this.bus = bus;
    this.persistence = persistence;

    this.pollIntervalMs = Math.max(1000, opts.pollIntervalMs ?? 30_000);
    this.ritualCompleteEvent = opts.ritualCompleteEvent ?? "ritual:core:completed";
    this.enforceOnBoot = opts.enforceOnBoot ?? true;

    this.lastDateKey = localDateKey(new Date());

    // Listen for ritual completion (reopen request).
    this.bus.on(this.ritualCompleteEvent, () => {
      this.reopenAfterRitual();
    });

    // Optional: allow dev/manual close/open via bus (future tooling).
    this.bus.on("gate:request-close", () => this.close("manual"));
    this.bus.on("gate:request-open", () => this.open("manual"));

    // Enforce persisted state immediately if needed.
    if (this.enforceOnBoot) {
      const gate = this.persistence.getState().gate;
      if (gate.status === "closed") {
        // Ensure visuals/audio are consistent without mutating timestamps.
        this.enforceClosed("boot-enforce");
      }
    }
  }

  update(dt: number): void {
    // dt comes in seconds in this codebase; poll interval is ms.
    this.accumulator += dt * 1000;

    if (this.accumulator < this.pollIntervalMs) return;
    this.accumulator = 0;

    const currentKey = localDateKey(new Date());
    if (currentKey !== this.lastDateKey) {
      this.lastDateKey = currentKey;
      this.close("midnight");
    }
  }

  /** True if gate is currently closed (from canonical persisted state). */
  isClosed(): boolean {
    return this.persistence.getState().gate.status === "closed";
  }

  /** Close the Still (persist + notify + request enforcement). */
  close(reason: GateClosingPayload["reason"]): void {
    const state = this.persistence.getState();
    const gate = state.gate;

    if (gate.status === "closed") {
      // Already closed; still ensure enforcement signals (idempotent).
      this.enforceClosed(reason);
      return;
    }

    const atMs = nowMs();

    const nextGate: GateState = {
      ...gate,
      status: "closed",
      lastClosedAtMs: atMs,
      // preserve lastOpenedAtMs as-is
    };

    this.bus.emit<GateClosingPayload>("gate:closing", { reason, atMs });

    // Persist as a critical moment: update + commit immediately.
    this.persistence.update({ gate: nextGate }, `gate:close:${reason}`);
    this.persistence.commit(`gate:close:${reason}`);

    this.enforceClosed(reason);

    this.bus.emit<GateClosingPayload>("gate:closed", { reason, atMs });
  }

  /** Open the Still (persist + notify + request restore). */
  open(reason: GateOpeningPayload["reason"]): void {
    const state = this.persistence.getState();
    const gate = state.gate;

    if (gate.status === "open") return;

    const atMs = nowMs();

    const nextGate: GateState = {
      ...gate,
      status: "open",
      lastOpenedAtMs: atMs,
      lastClosedAtMs: gate.lastClosedAtMs ?? null,
      reopenCount: (gate.reopenCount ?? 0) + 1,
    };

    this.bus.emit<GateOpeningPayload>("gate:opening", { reason, atMs });

    this.persistence.update({ gate: nextGate }, `gate:open:${reason}`);
    this.persistence.commit(`gate:open:${reason}`);

    // Request restoration of pre-close vibe (Harmony/Audio).
    this.bus.emit("harmony:resume", {});
    this.bus.emit("audio:resume", {});

    this.bus.emit<GateOpeningPayload>("gate:opened", { reason, atMs });
  }

  /** Ritual completion handler: only opens if currently closed. */
  reopenAfterRitual(): void {
    if (!this.isClosed()) return;
    this.open("ritual");
  }

  /** Emit enforcement requests for the closed state (idempotent). */
  private enforceClosed(reason: GateClosingPayload["reason"]): void {
    const atMs = nowMs();

    // Core forced to black hole.
    this.bus.emit("core:force-black-hole", { reason, atMs });

    // All audio fades to silence.
    this.bus.emit("audio:fade-to-silence", { reason, atMs, durationMs: 2500 });

    // Harmony should be considered paused/muted while closed.
    this.bus.emit("harmony:pause", { reason, atMs });
  }

  dispose(): void {
    // Currently no timers; we rely on Engine.update polling.
    // We do not remove bus handlers because EventBus doesn't track ownership.
    // If we add dynamic enable/disable later, we can store handlers and off() them.
  }
}
