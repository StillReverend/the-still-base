// src/systems/harmony/HarmonyEnvironmentSystem.ts
// ============================================================
// THE STILL — HarmonyEnvironmentSystem
//  - Canonical Environment options (color/filter/particles/ambients)
//  - Persists via PersistenceSystem
//  - Applies world effects (PostFX now, ParticleFX later)
//  - Broadcasts canonical state snapshots for HarmonySystem/UI
// ============================================================

import type { EventBus } from "../../core/EventBus";
import type { PersistenceSystem, HarmonyEnvironmentState } from "../PersistenceSystem";
import type { PostFXSystem } from "../PostFXSystem";

type AnyFn = (...args: any[]) => void;

export interface HarmonyEnvironmentSystemDeps {
  bus: EventBus;
  persistence: PersistenceSystem;
  postFX: PostFXSystem;
}

type HarmonyEnvironmentStateEvent = {
  // Provide multiple aliases so consumers can pick what they want:
  // - HarmonySystem can read .state or flattened fields
  // - Legacy/debug tools may read .environment
  state: HarmonyEnvironmentState;
  environment: HarmonyEnvironmentState;

  // Flat fields (extra convenient)
  colorId: string;
  filterId: string;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;

  reason: string;
};

const DEFAULT_ENV: HarmonyEnvironmentState = {
  colorId: "c1",
  filterId: "f1",
  particles: {},
  ambients: {},
};

const safeString = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v : fallback);
const safeBool = (v: unknown): boolean => Boolean(v);

const safeRecordBool = (v: unknown): Record<string, boolean> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || !k) continue;
    out[k] = safeBool(val);
  }
  return out;
};

const normalizeEnv = (raw: unknown): HarmonyEnvironmentState => {
  const r = (raw ?? {}) as Partial<HarmonyEnvironmentState>;
  return {
    colorId: safeString(r.colorId, DEFAULT_ENV.colorId),
    filterId: safeString(r.filterId, DEFAULT_ENV.filterId),
    particles: safeRecordBool(r.particles),
    ambients: safeRecordBool(r.ambients),
  };
};

export class HarmonyEnvironmentSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;
  private readonly postFX: PostFXSystem;

  private disposers: Array<() => void> = [];
  private initialized = false;

  constructor(deps: HarmonyEnvironmentSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.postFX = deps.postFX;
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Apply persisted environment immediately on boot
    const bootEnv = this.readPersisted();
    this.apply(bootEnv);

    // Broadcast canonical snapshot for late subscribers (HarmonySystem/UI, debug tools, etc.)
    this.emitState(bootEnv, "boot");

    // Listen to Harmony intent events (canonical names)
    this.on("harmony:environment:selectColor", (p: { colorId: string }) => {
      const colorId = safeString(p?.colorId, DEFAULT_ENV.colorId);
      this.set({ colorId }, "harmonyEnvironment:selectColor");
    });

    this.on("harmony:environment:selectFilter", (p: { filterId: string }) => {
      const filterId = safeString(p?.filterId, DEFAULT_ENV.filterId);
      this.set({ filterId }, "harmonyEnvironment:selectFilter");
    });

    this.on("harmony:environment:toggleParticle", (p: { particleId: string; enabled: boolean }) => {
      const id = safeString(p?.particleId, "");
      if (!id) return;

      const prev = this.readPersisted();
      const particles = { ...prev.particles, [id]: safeBool(p?.enabled) };

      this.set({ particles }, "harmonyEnvironment:toggleParticle");
    });

    this.on("harmony:environment:toggleAmbient", (p: { ambientId: string; enabled: boolean }) => {
      const id = safeString(p?.ambientId, "");
      if (!id) return;

      const prev = this.readPersisted();
      const ambients = { ...prev.ambients, [id]: safeBool(p?.enabled) };

      this.set({ ambients }, "harmonyEnvironment:toggleAmbient");
    });
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.initialized = false;
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private readPersisted(): HarmonyEnvironmentState {
    // Canonical state now lives in PersistenceSystem (typed).
    const state = this.persistence.getState();
    return normalizeEnv(state.harmonyEnvironment);
  }

  private writePersisted(partial: Partial<HarmonyEnvironmentState>, reason: string): void {
    // Canonical API (now exists):
    this.persistence.setHarmonyEnvironment(partial, reason);
  }

  private set(partial: Partial<HarmonyEnvironmentState>, reason: string): void {
    this.writePersisted(partial, reason);

    const next = this.readPersisted();
    this.apply(next);

    // Broadcast canonical state for HarmonySystem/UI to mirror
    this.emitState(next, reason);

    // Secondary "changed" event for ad-hoc listeners
    this.emitChanged(next, reason);
  }

  private emitState(environment: HarmonyEnvironmentState, reason: string): void {
    const payload: HarmonyEnvironmentStateEvent = {
      state: environment,
      environment,
      colorId: environment.colorId,
      filterId: environment.filterId,
      particles: environment.particles,
      ambients: environment.ambients,
      reason,
    };

    this.bus.emit<HarmonyEnvironmentStateEvent>("harmony:environment:state", payload);
  }

  private emitChanged(environment: HarmonyEnvironmentState, reason: string): void {
    const payload: HarmonyEnvironmentStateEvent = {
      state: environment,
      environment,
      colorId: environment.colorId,
      filterId: environment.filterId,
      particles: environment.particles,
      ambients: environment.ambients,
      reason,
    };

    this.bus.emit<HarmonyEnvironmentStateEvent>("harmony:environment:changed", payload);
  }

  private apply(environment: HarmonyEnvironmentState): void {
    // PostFX gets filter + color now (visible win).
    this.postFX.setHarmonyEnvironment({
      filterId: environment.filterId,
      colorId: environment.colorId,
    });

    // ParticleFX + Ambient will hook in later.
    // environment.particles / environment.ambients are already persisted.
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}
