// src/systems/harmony/HarmonyOptionsSystem.ts
// ============================================================
// THE STILL — HarmonyOptionsSystem
//  - Canonical "Harmony options" (color/filter/particles/ambients)
//  - Persists via PersistenceSystem
//  - Applies world effects (PostFX now, ParticleFX later)
// ============================================================

import type { EventBus } from "../../core/EventBus";
import type { PersistenceSystem, HarmonyOptionsState } from "../PersistenceSystem";
import type { PostFXSystem } from "../PostFXSystem";

type AnyFn = (...args: any[]) => void;

export interface HarmonyOptionsSystemDeps {
  bus: EventBus;
  persistence: PersistenceSystem;
  postFX: PostFXSystem;
}

export class HarmonyOptionsSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;
  private readonly postFX: PostFXSystem;

  private disposers: Array<() => void> = [];

  constructor(deps: HarmonyOptionsSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.postFX = deps.postFX;
  }

  public init(): void {
    // Apply persisted options immediately on boot
    this.apply(this.persistence.getState().harmonyOptions);

    // Listen to Harmony UI intent events (currently "vibe:*")
    this.on("vibe:selectColor", (p: { colorId: string }) => {
      const colorId = typeof p?.colorId === "string" ? p.colorId : "c1";
      this.set({ colorId }, "harmonyOptions:selectColor");
    });

    this.on("vibe:selectFilter", (p: { filterId: string }) => {
      const filterId = typeof p?.filterId === "string" ? p.filterId : "f1";
      this.set({ filterId }, "harmonyOptions:selectFilter");
    });

    this.on("vibe:toggleParticle", (p: { particleId: string; enabled: boolean }) => {
      const id = typeof p?.particleId === "string" ? p.particleId : "";
      if (!id) return;

      const prev = this.persistence.getState().harmonyOptions;
      const particles = { ...prev.particles, [id]: Boolean(p?.enabled) };

      this.set({ particles }, "harmonyOptions:toggleParticle");
    });

    this.on("vibe:toggleAmbient", (p: { ambientId: string; enabled: boolean }) => {
      const id = typeof p?.ambientId === "string" ? p.ambientId : "";
      if (!id) return;

      const prev = this.persistence.getState().harmonyOptions;
      const ambients = { ...prev.ambients, [id]: Boolean(p?.enabled) };

      this.set({ ambients }, "harmonyOptions:toggleAmbient");
    });
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private set(partial: Partial<HarmonyOptionsState>, reason: string): void {
    this.persistence.setHarmonyOptions(partial, reason);
    const next = this.persistence.getState().harmonyOptions;
    this.apply(next);

    // Optional: announce for future systems / debugging
    this.bus.emit("harmony:options:changed", { options: next, reason });
  }

  private apply(options: HarmonyOptionsState): void {
    // PostFX gets filter + color now (visible win)
    this.postFX.setHarmonyOptions({
      filterId: options.filterId,
      colorId: options.colorId,
    });

    // ParticleFX + Ambient will hook in later
    // (options.particles / options.ambients already persisted)
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}
