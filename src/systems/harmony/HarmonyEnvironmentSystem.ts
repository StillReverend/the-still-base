// src/systems/harmony/HarmonyEnvironmentSystem.ts
// ============================================================
// THE STILL — HarmonyEnvironmentSystem
//  - Canonical Environment options (filter/particles/ambients) MVP
//  - Persists via PersistenceSystem
//  - Applies world effects (PostFX now, ParticleFX now wired)
//  - Broadcasts canonical state snapshots for HarmonySystem/UI
//
// Patch (Mar 2026):
//  - Treat "stars" as a first-class particle radio option (deterministic).
//  - Winner selection now follows a stable priority order, not Object.entries() order.
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
  state: HarmonyEnvironmentState;
  environment: HarmonyEnvironmentState;
  filterId: string;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
  reason: string;
};

const DEFAULT_ENV: HarmonyEnvironmentState = {
  // @ts-expect-error back-compat
  colorId: "c1",
  filterId: "f1",
  particles: {},
  ambients: {},
};

const safeString = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim() ? v : fallback;

const safeBool = (v: unknown): boolean => Boolean(v);

const safeRecordBool = (v: unknown): Record<string, boolean> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = safeBool(val);
  }
  return out;
};

// ------------------------------------------------------------
// Particle radio group
// ------------------------------------------------------------

const KNOWN_PARTICLE_IDS = [
  // ✅ include stars as an explicit radio choice
  "stars",
  "embers",
  "dust",
  "rain",
  "snow",
  "fireflies",
  "leaves",
] as const;

const PARTICLE_PRIORITY: ReadonlyArray<string> = [...KNOWN_PARTICLE_IDS];

const enforceSingleParticleActive = (
  particlesIn: Record<string, boolean>,
): Record<string, boolean> => {
  const particles = { ...(particlesIn ?? {}) };

  let winner: string | null = null;

  // Prefer canonical priority order
  for (const k of PARTICLE_PRIORITY) {
    if (particles[k] === true) {
      winner = k;
      break;
    }
  }

  // If some unknown particle id is true, pick the first (stable by sort)
  if (!winner) {
    const otherTrue = Object.keys(particles)
      .filter((k) => particles[k] === true && !PARTICLE_PRIORITY.includes(k))
      .sort();
    winner = otherTrue.length ? otherTrue[0] : null;
  }

  const keys = new Set<string>([
    ...Object.keys(particles),
    ...KNOWN_PARTICLE_IDS,
  ]);

  const out: Record<string, boolean> = {};

  // None selected => canonicalize to all false
  if (!winner) {
    for (const k of keys) out[k] = false;
    return out;
  }

  for (const k of keys) out[k] = k === winner;
  return out;
};

const applyParticleToggleRadio = (
  prev: Record<string, boolean>,
  id: string,
  enabled: boolean,
): Record<string, boolean> => {
  const base = { ...(prev ?? {}) };

  const keys = new Set<string>([
    ...Object.keys(base),
    ...KNOWN_PARTICLE_IDS,
    id,
  ]);

  if (enabled) {
    const out: Record<string, boolean> = {};
    for (const k of keys) out[k] = k === id;
    return out;
  }

  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = k === id ? false : Boolean(base[k]);
  return out;
};

const getParticleWinner = (
  particles: Record<string, boolean> | undefined | null,
): string | null => {
  if (!particles) return null;

  // Deterministic: follow priority list first
  for (const k of PARTICLE_PRIORITY) {
    if (particles[k] === true) return k;
  }

  // If some unknown id is the active one, pick first sorted true key
  const otherTrue = Object.keys(particles)
    .filter((k) => particles[k] === true && !PARTICLE_PRIORITY.includes(k))
    .sort();

  return otherTrue.length ? otherTrue[0] : null;
};

const normalizeEnv = (raw: unknown): HarmonyEnvironmentState => {
  const r = (raw ?? {}) as Partial<HarmonyEnvironmentState>;

  const particles = enforceSingleParticleActive(
    safeRecordBool(r.particles),
  );

  const ambients = safeRecordBool(r.ambients);

  const base: any = {
    filterId: safeString((r as any).filterId, DEFAULT_ENV.filterId),
    particles,
    ambients,
  };

  if (typeof (r as any).colorId === "string") {
    base.colorId = (r as any).colorId;
  } else {
    base.colorId = (DEFAULT_ENV as any).colorId;
  }

  return base as HarmonyEnvironmentState;
};

export class HarmonyEnvironmentSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;
  private readonly postFX: PostFXSystem;

  private disposers: Array<() => void> = [];
  private initialized = false;

  // prevent redundant fieldfx mode emits
  // NOTE: initialize to sentinel so first apply() always emits (including mode:null).
  private lastFieldFxMode: string | null = "__unset__";

  constructor(deps: HarmonyEnvironmentSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.postFX = deps.postFX;
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const bootEnv = this.readPersisted();
    this.apply(bootEnv);
    this.emitState(bootEnv, "boot");

    this.on(
      "harmony:environment:requestState",
      (p: { source?: string } | undefined) => {
        const src = safeString(p?.source, "unknown");
        const current = this.readPersisted();
        this.apply(current);
        this.emitState(current, `requestState:${src}`);
      },
    );

    const onSelectFilter = (p: { filterId: string }) => {
      const filterId = safeString(p?.filterId, DEFAULT_ENV.filterId);
      this.set({ filterId }, "selectFilter");
    };

    this.on("harmony:environment:selectFilter", onSelectFilter);
    this.on("harmony:env:selectFilter", onSelectFilter);

    const onToggleParticle = (p: { particleId: string; enabled: boolean }) => {
      const id = safeString(p?.particleId, "");
      if (!id) return;

      const prev = this.readPersisted();
      const particles = applyParticleToggleRadio(
        prev.particles ?? {},
        id,
        safeBool(p?.enabled),
      );

      this.set({ particles }, "toggleParticle");
    };

    this.on("harmony:environment:toggleParticle", onToggleParticle);
    this.on("harmony:env:toggleParticle", onToggleParticle);
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.initialized = false;
  }

  private readPersisted(): HarmonyEnvironmentState {
    const state = this.persistence.getState();
    return normalizeEnv(state.harmonyEnvironment);
  }

  private writePersisted(
    partial: Partial<HarmonyEnvironmentState>,
    reason: string,
  ): void {
    this.persistence.setHarmonyEnvironment(partial, reason);
  }

  private set(
    partial: Partial<HarmonyEnvironmentState>,
    reason: string,
  ): void {
    if (partial.particles) {
      partial = {
        ...partial,
        particles: enforceSingleParticleActive(partial.particles),
      };
    }

    this.writePersisted(partial, reason);

    const next = this.readPersisted();
    this.apply(next);

    this.emitState(next, reason);
    this.emitChanged(next, reason);
  }

  private emitState(
    environment: HarmonyEnvironmentState,
    reason: string,
  ): void {
    const payload: HarmonyEnvironmentStateEvent = {
      state: environment,
      environment,
      filterId: (environment as any).filterId,
      particles: (environment as any).particles,
      ambients: (environment as any).ambients,
      reason,
    };

    this.bus.emit("harmony:environment:state", payload);
  }

  private emitChanged(
    environment: HarmonyEnvironmentState,
    reason: string,
  ): void {
    const payload: HarmonyEnvironmentStateEvent = {
      state: environment,
      environment,
      filterId: (environment as any).filterId,
      particles: (environment as any).particles,
      ambients: (environment as any).ambients,
      reason,
    };

    this.bus.emit("harmony:environment:changed", payload);
  }

  private apply(environment: HarmonyEnvironmentState): void {
    this.postFX.setHarmonyEnvironment({
      filterId: (environment as any).filterId,
      colorId:
        (environment as any).colorId ??
        (DEFAULT_ENV as any).colorId ??
        "c1",
    });

    // 🔥 Critical wiring: tell FieldFX which emitter to use
    // - "stars" => starfield mode (FieldFX should treat as pristine stars)
    // - null => no particles at all (quiet Still)
    const winner = getParticleWinner((environment as any).particles);

    if (winner !== this.lastFieldFxMode) {
      this.lastFieldFxMode = winner;
      this.bus.emit("fieldfx:mode:set", { mode: winner });
    }
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}