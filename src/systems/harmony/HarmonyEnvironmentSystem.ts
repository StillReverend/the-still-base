// src/systems/harmony/HarmonyEnvironmentSystem.ts
// ============================================================
// THE STILL — HarmonyEnvironmentSystem
//  - Canonical Environment options (filter/particles/ambients)   ✅ MVP
//  - Persists via PersistenceSystem
//  - Applies world effects (PostFX now, ParticleFX later)
//  - Broadcasts canonical state snapshots for HarmonySystem/UI
//
// Notes (Feb 2026):
//  - "Presets" should OVERWRITE the full environment state (A).
//  - HarmonySystem/HarmonyUI emit intent via EventBus only.
//  - Particles are a RADIO GROUP: one active global particle mode at a time.
//
// MVP (Mar 2026):
//  - REMOVE: Colors plumbing
//    - No selectColor listener
//    - No colorId flattened in emitted payloads
//    - We still tolerate/retain colorId in persisted state for backwards compat,
//      but Harmony no longer drives it.
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
  // - HarmonySystem reads .state/.environment or flattened fields
  // - Legacy/debug tools may read .environment
  state: HarmonyEnvironmentState;
  environment: HarmonyEnvironmentState;

  // Flat fields (extra convenient)
  filterId: string;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;

  reason: string;
};

// NOTE: Persistence may still carry colorId in HarmonyEnvironmentState.
// MVP: we keep a default for normalization/back-compat, but we do not expose
// color as a first-class Harmony-driven control surface anymore.
const DEFAULT_ENV: HarmonyEnvironmentState = {
  // @ts-expect-error - if HarmonyEnvironmentState no longer includes colorId, this is harmless.
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

// ------------------------------------------------------------
// ✅ Particle radio-group enforcement (global: one active at a time)
// ------------------------------------------------------------

const KNOWN_PARTICLE_IDS = ["embers", "dust", "rain", "snow", "fireflies", "leaves"] as const;
type KnownParticleId = (typeof KNOWN_PARTICLE_IDS)[number];

// Priority order when multiple are true (e.g., preset mistakes).
// You can reorder this later to match your “vibe ladder”.
const PARTICLE_PRIORITY: ReadonlyArray<string> = [...KNOWN_PARTICLE_IDS];

/**
 * Returns a copy of the particles map with at most ONE true value.
 * Deterministic selection:
 *  1) first true in PARTICLE_PRIORITY
 *  2) else first true among other keys (sorted)
 *  3) else all false
 */
const enforceSingleParticleActive = (particlesIn: Record<string, boolean>): Record<string, boolean> => {
  const particles = { ...(particlesIn ?? {}) };

  // Find winner (priority first)
  let winner: string | null = null;

  for (const k of PARTICLE_PRIORITY) {
    if (particles[k] === true) {
      winner = k;
      break;
    }
  }

  if (!winner) {
    const otherTrueKeys = Object.keys(particles)
      .filter((k) => particles[k] === true && !PARTICLE_PRIORITY.includes(k))
      .sort();
    winner = otherTrueKeys.length ? otherTrueKeys[0] : null;
  }

  // If no winner, clear everything to false (but keep keys for UI stability)
  if (!winner) {
    const out: Record<string, boolean> = {};
    for (const k of Object.keys(particles)) out[k] = false;
    // Also include known keys so UI always sees them
    for (const k of KNOWN_PARTICLE_IDS) out[k] = false;
    return out;
  }

  // Winner exists: set winner true, all others false (including known keys)
  const out: Record<string, boolean> = {};
  const keys = new Set<string>([...Object.keys(particles), ...KNOWN_PARTICLE_IDS]);
  for (const k of keys) out[k] = k === winner;
  return out;
};

/**
 * Toggle behavior for radio group:
 * - enabled=true: winner becomes id, all others false
 * - enabled=false: id becomes false, all others false too (since only one can be active)
 */
const applyParticleToggleRadio = (prev: Record<string, boolean>, id: string, enabled: boolean): Record<string, boolean> => {
  const base: Record<string, boolean> = { ...(prev ?? {}) };

  if (enabled) {
    // Set id true, everything else false
    const out: Record<string, boolean> = {};
    const keys = new Set<string>([...Object.keys(base), ...KNOWN_PARTICLE_IDS, id]);
    for (const k of keys) out[k] = k === id;
    return out;
  }

  // enabled=false: clear all (since only one state allowed)
  const out: Record<string, boolean> = {};
  const keys = new Set<string>([...Object.keys(base), ...KNOWN_PARTICLE_IDS, id]);
  for (const k of keys) out[k] = false;
  return out;
};

// ------------------------------------------------------------

const normalizeEnv = (raw: unknown): HarmonyEnvironmentState => {
  const r = (raw ?? {}) as Partial<HarmonyEnvironmentState>;
  const particles = safeRecordBool(r.particles);
  const ambients = safeRecordBool(r.ambients);

  // ✅ Normalize particles into a single-active radio group state.
  const particlesSingle = enforceSingleParticleActive(particles);

  // Keep filter/particles/ambients canonical for MVP.
  // Retain colorId in the returned object if the persistence type carries it,
  // but Harmony is no longer responsible for changing it.
  const base: any = {
    filterId: safeString((r as any).filterId, (DEFAULT_ENV as any).filterId),
    particles: particlesSingle,
    ambients,
  };

  // If a colorId exists in persistence shape, preserve it; else ignore.
  if (typeof (r as any).colorId === "string" && (r as any).colorId.trim()) {
    base.colorId = (r as any).colorId.trim();
  } else if (typeof (DEFAULT_ENV as any).colorId === "string") {
    base.colorId = (DEFAULT_ENV as any).colorId;
  }

  return base as HarmonyEnvironmentState;
};

// Payload accepted for full overwrite apply.
// We support either:
//  - { environment: HarmonyEnvironmentState, source?: string }
//  - HarmonyEnvironmentState directly (legacy / convenience)
type HarmonyEnvironmentApplyPayload =
  | { environment: HarmonyEnvironmentState; source?: string }
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (HarmonyEnvironmentState & {});

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

    // Broadcast canonical snapshot for early subscribers
    this.emitState(bootEnv, "boot");

    // ------------------------------------------------------------
    // ✅ Boot-sync handshake: late subscribers can request state
    // ------------------------------------------------------------
    this.on("harmony:environment:requestState", (p: { source?: string } | undefined) => {
      const src = safeString(p?.source, "unknown");
      const current = this.readPersisted();

      // Ensure world effects match canonical state
      this.apply(current);

      // Broadcast canonical state
      this.emitState(current, `requestState:${src}`);
    });

    // Listen to Harmony intent events (canonical names)
    // ✅ MVP: NO color selection listener anymore.

    this.on("harmony:environment:selectFilter", (p: { filterId: string }) => {
      const filterId = safeString(p?.filterId, (DEFAULT_ENV as any).filterId ?? "f1");
      this.set({ filterId }, "harmonyEnvironment:selectFilter");
    });

    // ✅ Particles are a radio group (one active global mode)
    this.on("harmony:environment:toggleParticle", (p: { particleId: string; enabled: boolean }) => {
      const id = safeString(p?.particleId, "");
      if (!id) return;

      const prev = this.readPersisted();

      const particles = applyParticleToggleRadio(prev.particles ?? {}, id, safeBool(p?.enabled));
      this.set({ particles }, "harmonyEnvironment:toggleParticle");
    });

    this.on("harmony:environment:toggleAmbient", (p: { ambientId: string; enabled: boolean }) => {
      const id = safeString(p?.ambientId, "");
      if (!id) return;

      const prev = this.readPersisted();
      const ambients = { ...prev.ambients, [id]: safeBool(p?.enabled) };

      this.set({ ambients }, "harmonyEnvironment:toggleAmbient");
    });

    // ✅ Apply a full environment snapshot (Preset apply).
    // IMPORTANT: This OVERWRITES ALL environment values (A).
    this.on("harmony:environment:apply", (p: HarmonyEnvironmentApplyPayload) => {
      const envRaw =
        p && typeof p === "object" && "environment" in (p as Record<string, unknown>)
          ? (p as { environment: HarmonyEnvironmentState }).environment
          : (p as unknown);

      const nextFull = normalizeEnv(envRaw);

      // Overwrite persistence in a way that works whether or not a dedicated
      // replaceHarmonyEnvironment() API exists yet.
      this.writePersistedReplace(nextFull, "harmonyEnvironment:apply");

      const next = this.readPersisted();
      this.apply(next);

      // Broadcast canonical state for HarmonySystem/UI to mirror
      this.emitState(next, "harmonyEnvironment:apply");
      this.emitChanged(next, "harmonyEnvironment:apply");
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
    // Canonical API (merge semantics)
    this.persistence.setHarmonyEnvironment(partial, reason);
  }

  /**
   * Overwrite semantics (Preset apply):
   * - Prefer persistence.replaceHarmonyEnvironment(nextFull, reason) if present.
   * - Otherwise overwrite via persistence.update({ harmonyEnvironment: nextFull }, reason).
   */
  private writePersistedReplace(nextFull: HarmonyEnvironmentState, reason: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyPersistence = this.persistence as any;

    if (typeof anyPersistence.replaceHarmonyEnvironment === "function") {
      anyPersistence.replaceHarmonyEnvironment(nextFull, reason);
      return;
    }

    // Fallback: PersistenceSystem always has update(), so we can still overwrite.
    if (typeof anyPersistence.update === "function") {
      anyPersistence.update({ harmonyEnvironment: nextFull }, reason);
      return;
    }

    // Absolute fallback (should not happen): fall back to merge,
    // but this will NOT clear unspecified keys. Better than crash.
    this.writePersisted(nextFull, reason);
  }

  private set(partial: Partial<HarmonyEnvironmentState>, reason: string): void {
    // ✅ Safety: if particles are present, enforce radio group even for partial writes.
    if (partial.particles) {
      partial = { ...partial, particles: enforceSingleParticleActive(partial.particles) };
    }

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
      filterId: (environment as any).filterId,
      particles: (environment as any).particles,
      ambients: (environment as any).ambients,
      reason,
    };

    this.bus.emit<HarmonyEnvironmentStateEvent>("harmony:environment:state", payload);
  }

  private emitChanged(environment: HarmonyEnvironmentState, reason: string): void {
    const payload: HarmonyEnvironmentStateEvent = {
      state: environment,
      environment,
      filterId: (environment as any).filterId,
      particles: (environment as any).particles,
      ambients: (environment as any).ambients,
      reason,
    };

    this.bus.emit<HarmonyEnvironmentStateEvent>("harmony:environment:changed", payload);
  }

  private apply(environment: HarmonyEnvironmentState): void {
    // MVP: Harmony drives FILTERS only.
    // We still *tolerate* a colorId in the persisted shape for backwards compat,
    // but Harmony is no longer responsible for controlling it.
    this.postFX.setHarmonyEnvironment({
      filterId: (environment as any).filterId,
      // Keep colorId stable if PostFX expects it; otherwise this is ignored.
      colorId: (environment as any).colorId ?? (DEFAULT_ENV as any).colorId ?? "c1",
    });

    // ParticleFX + Ambient listen via bus snapshots.
    // environment.particles / environment.ambients are already persisted and broadcast.
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}