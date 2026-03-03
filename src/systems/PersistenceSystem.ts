// src/systems/PersistenceSystem.ts
// ============================================================
// THE STILL — Phase 1
// PersistenceSystem
// ------------------------------------------------------------
// Responsibilities:
//  - Own canonical UserState (gate, player, harmony, collected tracks)
//  - Load + save via existing SaveManager (treated as schema-agnostic)
//  - Debounced autosave + explicit commit() for critical moments
//
// Notes:
//  - Additive system: does NOT modify existing SaveManager typings.
//  - Other systems should treat PersistenceSystem as the single source of truth.
//
// MVP (Mar 2026):
//  - Harmony unlocks: KEEP filters/particles/ambients/presets
//  - REMOVE unlock ledger for colors (colors are no longer part of Harmony MVP unlocks)
//  - IMPORTANT: do NOT emit "harmony:policy:set" from Persistence (would self-trigger).
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { SaveManager } from "../core/SaveManager";

export type GateStatus = "open" | "closed";

export interface GateState {
  status: GateStatus;
  /** When the gate was last opened, in ms since epoch (Date.now()). */
  lastOpenedAtMs: number | null;
  /** When the gate was last closed, in ms since epoch (Date.now()). */
  lastClosedAtMs: number | null;
  /** How many times the player has reopened the Still via ritual. */
  reopenCount: number;
}

export interface PlayerState {
  /** Reserved for future use (e.g. profile, unlocks). */
  id: string | null;
  /** Reserved for future use (e.g. last known position). */
  lastKnown: {
    x: number;
    y: number;
    z: number;
  } | null;
}

export interface HarmonyLayerState {
  id: string;
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export interface HarmonyState {
  enabled: boolean;
  masterVolume: number; // 0..1
  layers: Record<string, HarmonyLayerState>;
}

export type RepeatMode = "off" | "one" | "all";

export interface TrackState {
  /** Canonical track id, matching your track metadata registry. */
  id: string;
  /** Whether the track is unlocked/collected. */
  unlocked: boolean;
  /** Favorited by the user. */
  favorite: boolean;
  /** Last known playhead in seconds (for resume). */
  lastTimeSec: number;
}

export interface AudioPlayerState {
  activeTrackId: string | null;

  /** Last known playback state (for resume UX). */
  isPlaying: boolean;

  /** Last known playhead seconds (for resume). */
  timeSec: number;

  /** Last known duration seconds (if known). */
  durationSec: number | null;

  shuffle: boolean;
  repeat: RepeatMode;
  volume: number; // 0..1
}

// ------------------------------------------------------------
// NEW: Harmony Environment persistence (environment selections)
// ------------------------------------------------------------

export interface HarmonyEnvironmentState {
  // NOTE: Kept for now because PostFX may still use it,
  // but Harmony MVP no longer "unlocks" or actively "selects" colors.
  colorId: string;
  filterId: string;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
}

// ------------------------------------------------------------
// NEW: Director/Lumen + UI mode + unlocks/capabilities
// ------------------------------------------------------------

export type UserOwner = "director" | "lumen";
export type UIMode = "cinematic" | "minimal" | "full";

/**
 * Generic boolean feature toggles.
 * Examples: "canUploadAudio", "canCreateRemnant", "showDebug", etc.
 * Keep this schema-flexible so we don't churn versions.
 */
export type CapabilityOverrides = Record<string, boolean>;

/**
 * Canonical unlock ledgers for Harmony.
 * These are "collected / available" flags, not "currently enabled" flags
 * (enabled is driven by HarmonyEnvironmentState).
 *
 * MVP: colors removed from the unlock ledger.
 */
export interface HarmonyUnlocksState {
  filters: Record<string, boolean>;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
  presets: Record<string, boolean>;
}

export interface UserState {
  /** Schema version for migrations. */
  version: 1;

  gate: GateState;
  player: PlayerState;

  harmony: HarmonyState;
  audio: AudioPlayerState;

  /** NEW: Canonical environment selections (color/filter/particles/ambients). */
  harmonyEnvironment: HarmonyEnvironmentState;

  /** NEW: Persisted toggle for UI hover/click bleeps (keeps wiring but can be off by default). */
  uiSfxEnabled: boolean;

  /** NEW: Who "owns" the session (affects UI + permissions elsewhere). */
  owner: UserOwner;

  /** NEW: UI mode preference (cinematic/minimal/full). */
  uiMode: UIMode;

  /** NEW: Optional capability overrides (schema-flexible). */
  capabilityOverrides: CapabilityOverrides;

  /** NEW: Collected/unlocked Harmony content (filters/particles/ambients/presets). */
  harmonyUnlocks: HarmonyUnlocksState;

  /** Canonical collection of tracks */
  tracks: Record<string, TrackState>;

  /** Timestamps */
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PersistenceSystemDeps {
  bus: EventBus;
  save: SaveManager;

  /**
   * Debounce window for autosave after state changes.
   * Default: 750ms
   */
  autosaveDebounceMs?: number;
}

export interface PersistenceLoadedPayload {
  state: UserState;
  /** true if loaded from storage, false if initialized fresh */
  fromSave: boolean;
}

export interface PersistenceChangedPayload {
  state: UserState;
  reason: string;
}

export interface PersistenceSavedPayload {
  state: UserState;
  reason: string;
  /** true if saved via commit(), false if autosave */
  explicit: boolean;
}

const SAVE_KEY = "userState";

// We intentionally treat SaveManager as schema-agnostic via a narrow escape hatch.
// This avoids changing SaveManager typings for Phase 1.
type SaveManagerAny = SaveManager & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (key: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (key: any, value: any) => void;
};

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
};

const clampNonNeg = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, v);
};

const nowMs = (): number => Date.now();

const DEFAULT_ENV: HarmonyEnvironmentState = {
  colorId: "c1",
  filterId: "f1",
  particles: {},
  ambients: {},
};

const DEFAULT_UNLOCKS: HarmonyUnlocksState = {
  filters: { f1: true },
  particles: {},
  ambients: {},
  presets: {},
};

const safeString = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v : fallback);

const safeRecordBool = (v: unknown): Record<string, boolean> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || !k) continue;
    out[k] = Boolean(val);
  }
  return out;
};

const normalizeEnv = (raw: unknown): HarmonyEnvironmentState => {
  const r = (raw ?? {}) as Partial<HarmonyEnvironmentState>;
  return {
    // Keep stable for PostFX even if Harmony MVP doesn't drive it.
    colorId: safeString(r.colorId, DEFAULT_ENV.colorId),
    filterId: safeString(r.filterId, DEFAULT_ENV.filterId),
    particles: safeRecordBool(r.particles),
    ambients: safeRecordBool(r.ambients),
  };
};

const normalizeUnlocks = (raw: unknown): HarmonyUnlocksState => {
  const r = (raw ?? {}) as Partial<HarmonyUnlocksState> & { colors?: unknown }; // tolerate legacy saves
  const filters = safeRecordBool((r as any).filters);
  const particles = safeRecordBool((r as any).particles);
  const ambients = safeRecordBool((r as any).ambients);
  const presets = safeRecordBool((r as any).presets);

  // Ensure base defaults exist (f1)
  filters.f1 = filters.f1 ?? true;

  return { filters, particles, ambients, presets };
};

const normalizeOwner = (v: unknown): UserOwner => (v === "director" ? "director" : "lumen");

const normalizeUiMode = (v: unknown): UIMode => {
  if (v === "cinematic" || v === "minimal" || v === "full") return v;
  return "full";
};

const createDefaultState = (): UserState => {
  const t = nowMs();

  return {
    version: 1,
    gate: {
      status: "open",
      lastOpenedAtMs: t,
      lastClosedAtMs: null,
      reopenCount: 0,
    },
    player: {
      id: null,
      lastKnown: null,
    },
    harmony: {
      enabled: true,
      masterVolume: 0.65,
      layers: {},
    },
    audio: {
      activeTrackId: null,
      isPlaying: false,
      timeSec: 0,
      durationSec: null,
      shuffle: false,
      repeat: "off",
      volume: 0.85,
    },
    harmonyEnvironment: { ...DEFAULT_ENV },
    uiSfxEnabled: true,

    // NEW defaults
    owner: "lumen",
    uiMode: "full",
    capabilityOverrides: {},
    harmonyUnlocks: { ...DEFAULT_UNLOCKS },

    tracks: {},
    createdAtMs: t,
    updatedAtMs: t,
  };
};

const sanitizeState = (state: UserState): UserState => {
  // Defensive clamping / normalization for future-proofing.
  const rawDuration = (state.audio as Partial<AudioPlayerState>)?.durationSec;

  const s: UserState = {
    ...state,
    version: 1,
    gate: {
      status: state.gate?.status === "closed" ? "closed" : "open",
      lastOpenedAtMs: Number.isFinite(state.gate?.lastOpenedAtMs ?? NaN) ? (state.gate.lastOpenedAtMs as number) : null,
      lastClosedAtMs: Number.isFinite(state.gate?.lastClosedAtMs ?? NaN) ? (state.gate.lastClosedAtMs as number) : null,
      reopenCount: Number.isFinite(state.gate?.reopenCount ?? NaN) ? Math.max(0, state.gate.reopenCount) : 0,
    },
    player: {
      id: typeof state.player?.id === "string" ? state.player.id : null,
      lastKnown:
        state.player?.lastKnown &&
        Number.isFinite(state.player.lastKnown.x) &&
        Number.isFinite(state.player.lastKnown.y) &&
        Number.isFinite(state.player.lastKnown.z)
          ? { ...state.player.lastKnown }
          : null,
    },
    harmony: {
      enabled: Boolean(state.harmony?.enabled),
      masterVolume: clamp01(state.harmony?.masterVolume ?? 0),
      layers: {},
    },
    audio: {
      activeTrackId: typeof state.audio?.activeTrackId === "string" ? state.audio.activeTrackId : null,
      isPlaying: Boolean((state.audio as Partial<AudioPlayerState>)?.isPlaying),
      timeSec: Number.isFinite((state.audio as Partial<AudioPlayerState>)?.timeSec ?? NaN)
        ? Math.max(0, Number((state.audio as Partial<AudioPlayerState>).timeSec))
        : 0,
      durationSec: rawDuration == null ? null : Number.isFinite(rawDuration) ? Math.max(0, Number(rawDuration)) : null,
      shuffle: Boolean(state.audio?.shuffle),
      repeat: state.audio?.repeat === "one" || state.audio?.repeat === "all" ? state.audio.repeat : "off",
      volume: clamp01(state.audio?.volume ?? 0),
    },
    harmonyEnvironment: normalizeEnv((state as unknown as { harmonyEnvironment?: unknown })?.harmonyEnvironment),
    uiSfxEnabled: Boolean((state as unknown as { uiSfxEnabled?: unknown })?.uiSfxEnabled),

    // NEW fields
    owner: normalizeOwner((state as unknown as { owner?: unknown })?.owner),
    uiMode: normalizeUiMode((state as unknown as { uiMode?: unknown })?.uiMode),
    capabilityOverrides: safeRecordBool((state as unknown as { capabilityOverrides?: unknown })?.capabilityOverrides),
    harmonyUnlocks: normalizeUnlocks((state as unknown as { harmonyUnlocks?: unknown })?.harmonyUnlocks),

    tracks: {},
    createdAtMs: Number.isFinite(state.createdAtMs) ? state.createdAtMs : nowMs(),
    updatedAtMs: nowMs(),
  };

  // Harmony layers
  if (state.harmony?.layers && typeof state.harmony.layers === "object") {
    for (const [id, layer] of Object.entries(state.harmony.layers)) {
      if (!layer || typeof layer !== "object") continue;
      s.harmony.layers[id] = {
        id,
        volume: clamp01((layer as HarmonyLayerState).volume ?? 0),
        muted: Boolean((layer as HarmonyLayerState).muted),
      };
    }
  }

  // Tracks
  if (state.tracks && typeof state.tracks === "object") {
    for (const [id, track] of Object.entries(state.tracks)) {
      if (!track || typeof track !== "object") continue;
      const t = track as TrackState;
      s.tracks[id] = {
        id,
        unlocked: Boolean(t.unlocked),
        favorite: Boolean(t.favorite),
        lastTimeSec: Number.isFinite(t.lastTimeSec) ? Math.max(0, t.lastTimeSec) : 0,
      };
    }
  }

  // Ensure base unlock defaults are present
  s.harmonyUnlocks.filters.f1 = s.harmonyUnlocks.filters.f1 ?? true;

  return s;
};

const isUserStateV1 = (raw: unknown): raw is UserState => {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Partial<UserState>;
  return r.version === 1 && typeof r.gate === "object" && typeof r.harmony === "object" && typeof r.audio === "object";
};

const safeClone = <T>(v: T): T => {
  // structuredClone is ideal; JSON fallback is fine for our plain-data state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc = (globalThis as any).structuredClone as ((x: unknown) => unknown) | undefined;
  if (typeof sc === "function") return sc(v) as T;
  return JSON.parse(JSON.stringify(v)) as T;
};

// ------------------------------------------------------------
// NEW: Harmony policy + unlock intent payloads (bus contract)
// ------------------------------------------------------------

type HarmonyPolicyPayload = {
  owner?: UserOwner | string;
  uiMode?: UIMode | string;
  capabilities?: Record<string, boolean>;
  unlocks?: Partial<HarmonyUnlocksState>;
  source?: string;
  reason?: string;
  [k: string]: unknown;
};

type HarmonyUnlockAddPayload = {
  kind: "filter" | "particle" | "ambient" | "preset";
  id: string;
  unlocked?: boolean; // default true
  source?: string;
  reason?: string;
  [k: string]: unknown;
};

type HarmonyDevUnlockAllPayload = {
  enabled?: boolean; // default true
  source?: string;
  reason?: string;
  [k: string]: unknown;
};

type HarmonyDevToggleOwnerPayload = {
  owner?: UserOwner | "director" | "lumen";
  source?: string;
  reason?: string;
  [k: string]: unknown;
};

const normalizeBoolMapPartial = (raw: unknown): Record<string, boolean> => safeRecordBool(raw);

const mergeUnlocks = (prev: HarmonyUnlocksState, next: Partial<HarmonyUnlocksState>): HarmonyUnlocksState => {
  return normalizeUnlocks({
    filters: { ...(prev.filters ?? {}), ...normalizeBoolMapPartial(next.filters) },
    particles: { ...(prev.particles ?? {}), ...normalizeBoolMapPartial(next.particles) },
    ambients: { ...(prev.ambients ?? {}), ...normalizeBoolMapPartial(next.ambients) },
    presets: { ...(prev.presets ?? {}), ...normalizeBoolMapPartial(next.presets) },
  });
};

export class PersistenceSystem {
  private readonly bus: EventBus;
  private readonly save: SaveManagerAny;

  private readonly autosaveDebounceMs: number;
  private autosaveTimer: number | null = null;

  private state: UserState;
  private loadedFromSave: boolean;

  // HMR-safe: stored handler refs for off() on dispose
  private readonly onUiSfxUpdate: (p: { enabled?: boolean } | undefined) => void;

  // NEW: Harmony policy/unlocks handlers (HMR-safe)
  private readonly onHarmonyPolicyRequest: (p?: { source?: string } | undefined) => void;
  private readonly onHarmonyPolicySet: (p: HarmonyPolicyPayload) => void;
  private readonly onHarmonyUnlockAdd: (p: HarmonyUnlockAddPayload) => void;
  private readonly onHarmonyDevUnlockAll: (p?: HarmonyDevUnlockAllPayload) => void;
  private readonly onHarmonyDevToggleOwner: (p?: HarmonyDevToggleOwnerPayload) => void;

  constructor(deps: PersistenceSystemDeps) {
    this.bus = deps.bus;
    this.save = deps.save as SaveManagerAny;
    this.autosaveDebounceMs = Math.max(0, deps.autosaveDebounceMs ?? 750);

    const loaded = this.loadFromSave();
    this.state = loaded.state;
    this.loadedFromSave = loaded.fromSave;

    // ✅ Listen for UI SFX persistence updates (from HowlerAudioSystem or future UI)
    this.onUiSfxUpdate = (p): void => {
      const enabled = Boolean(p?.enabled);
      if (this.state.uiSfxEnabled === enabled) return;
      this.update({ uiSfxEnabled: enabled }, "ui-sfx:setEnabled");
    };
    this.bus.on("persistence:update-ui-sfx", this.onUiSfxUpdate);

    // ------------------------------------------------------------
    // NEW: Harmony policy + unlock persistence (authoritative)
    // ------------------------------------------------------------

    // Any system can request current policy (boot handshakes, late subscribers)
    this.onHarmonyPolicyRequest = (p): void => {
      this.emitHarmonyPolicy(`request:${safeString(p?.source, "unknown")}`);
    };
    this.bus.on("harmony:policy:request", this.onHarmonyPolicyRequest);

    // Authoritative policy set (use sparingly; typically Engine/dev tools)
    this.onHarmonyPolicySet = (p: HarmonyPolicyPayload): void => {
      if (!p || typeof p !== "object") return;

      const nextOwner = p.owner != null ? normalizeOwner(p.owner) : this.state.owner;
      const nextUiMode = p.uiMode != null ? normalizeUiMode(p.uiMode) : this.state.uiMode;

      const nextCaps =
        p.capabilities && typeof p.capabilities === "object"
          ? { ...(this.state.capabilityOverrides ?? {}), ...safeRecordBool(p.capabilities) }
          : this.state.capabilityOverrides;

      const nextUnlocks =
        p.unlocks && typeof p.unlocks === "object"
          ? mergeUnlocks(this.state.harmonyUnlocks ?? DEFAULT_UNLOCKS, p.unlocks)
          : this.state.harmonyUnlocks;

      const changed =
        nextOwner !== this.state.owner ||
        nextUiMode !== this.state.uiMode ||
        JSON.stringify(nextCaps) !== JSON.stringify(this.state.capabilityOverrides) ||
        JSON.stringify(nextUnlocks) !== JSON.stringify(this.state.harmonyUnlocks);

      if (!changed) return;

      this.update(
        {
          owner: nextOwner,
          uiMode: nextUiMode,
          capabilityOverrides: nextCaps,
          harmonyUnlocks: nextUnlocks,
        },
        safeString(p.reason, "harmony:policy:set"),
      );

      // Re-emit canonical policy after applying
      this.emitHarmonyPolicy(`policy:set:${safeString(p.source, "unknown")}`);
    };
    this.bus.on("harmony:policy:set", this.onHarmonyPolicySet);

    // Add or revoke a single unlock (the common gameplay hook)
    this.onHarmonyUnlockAdd = (p: HarmonyUnlockAddPayload): void => {
      const kind = safeString(p?.kind, "") as HarmonyUnlockAddPayload["kind"];
      const id = safeString(p?.id, "").trim();
      if (!id) return;

      const unlocked = p?.unlocked === undefined ? true : Boolean(p.unlocked);

      const prev = this.state.harmonyUnlocks ?? DEFAULT_UNLOCKS;
      const next: HarmonyUnlocksState = safeClone(prev);

      if (kind === "filter") next.filters = { ...(prev.filters ?? {}), [id]: unlocked };
      else if (kind === "particle") next.particles = { ...(prev.particles ?? {}), [id]: unlocked };
      else if (kind === "ambient") next.ambients = { ...(prev.ambients ?? {}), [id]: unlocked };
      else if (kind === "preset") next.presets = { ...(prev.presets ?? {}), [id]: unlocked };
      else return;

      // Normalize + ensure f1 present
      const normalized = normalizeUnlocks(next);

      // No-op guard
      if (JSON.stringify(normalized) === JSON.stringify(prev)) return;

      this.update({ harmonyUnlocks: normalized }, safeString(p.reason, `harmony:unlock:${kind}:${id}`));
      this.emitHarmonyPolicy(`unlock:add:${safeString(p.source, "unknown")}`);
    };
    this.bus.on("harmony:unlock:add", this.onHarmonyUnlockAdd);

    // DEV hatch: unlock everything by switching to director (bypasses gating entirely)
    this.onHarmonyDevUnlockAll = (p?: HarmonyDevUnlockAllPayload): void => {
      const enabled = p?.enabled === undefined ? true : Boolean(p.enabled);
      if (!enabled) return;

      // “Director” bypass is the only reliable unlock-all without needing catalogs.
      // We ALSO stamp a capability flag so we can detect this later if needed.
      const caps = { ...(this.state.capabilityOverrides ?? {}) };
      caps["dev.unlockAll"] = true;

      const reason = safeString(p?.reason, "harmony:dev:unlockAll");
      const source = safeString(p?.source, "unknown");

      const changed = this.state.owner !== "director" || !this.state.capabilityOverrides?.["dev.unlockAll"];
      if (!changed) {
        this.emitHarmonyPolicy(`dev:unlockAll:${source}`);
        return;
      }

      this.update(
        {
          owner: "director",
          capabilityOverrides: caps,
        },
        reason,
      );

      this.emitHarmonyPolicy(`dev:unlockAll:${source}`);
    };
    this.bus.on("harmony:dev:unlockAll", this.onHarmonyDevUnlockAll);

    // DEV hatch: toggle owner (director <-> lumen) or explicitly set it
    this.onHarmonyDevToggleOwner = (p?: HarmonyDevToggleOwnerPayload): void => {
      const desired =
        p?.owner === "director" || p?.owner === "lumen"
          ? (p.owner as UserOwner)
          : this.state.owner === "director"
            ? "lumen"
            : "director";

      if (desired === this.state.owner) return;

      const reason = safeString(p?.reason, "harmony:dev:toggleOwner");
      const source = safeString(p?.source, "unknown");

      this.update({ owner: desired }, reason);
      this.emitHarmonyPolicy(`dev:owner:${source}`);
    };
    this.bus.on("harmony:dev:toggleOwner", this.onHarmonyDevToggleOwner);

    // ------------------------------------------------------------
    // Initial announce
    // ------------------------------------------------------------
    this.bus.emit<PersistenceLoadedPayload>("persistence:loaded", {
      state: this.getState(),
      fromSave: this.loadedFromSave,
    });

    // Also emit Harmony policy immediately so HarmonySystem can hydrate without Engine glue
    this.emitHarmonyPolicy("boot");
  }

  /** Returns a deep-ish copy safe for consumers (no mutation). */
  getState(): UserState {
    return safeClone(this.state);
  }

  // ------------------------------------------------------------
  // Convenience getters for Harmony environment
  // ------------------------------------------------------------

  getHarmonyEnvironment(): HarmonyEnvironmentState {
    return safeClone(this.state.harmonyEnvironment);
  }

  /**
   * Canonical API expected by HarmonyEnvironmentSystem:
   *   setHarmonyEnvironment(partial, reason)
   *
   * NOTE: This MERGES particles/ambients maps.
   */
  setHarmonyEnvironment(partial: Partial<HarmonyEnvironmentState>, reason = "harmonyEnvironment:set"): void {
    const prev = this.state.harmonyEnvironment ?? { ...DEFAULT_ENV };

    const next: HarmonyEnvironmentState = normalizeEnv({
      ...prev,
      ...partial,
      particles: partial.particles ? { ...prev.particles, ...partial.particles } : prev.particles,
      ambients: partial.ambients ? { ...prev.ambients, ...partial.ambients } : prev.ambients,
    });

    // No-op guard (keeps autosave calm)
    const same =
      prev.colorId === next.colorId &&
      prev.filterId === next.filterId &&
      JSON.stringify(prev.particles) === JSON.stringify(next.particles) &&
      JSON.stringify(prev.ambients) === JSON.stringify(next.ambients);

    if (same) return;

    this.update({ harmonyEnvironment: next }, reason);
  }

  /**
   * NEW: Replace (overwrite) the entire HarmonyEnvironmentState.
   * Required for Harmony Presets (A semantics).
   *
   * NOTE: This DOES NOT merge particles/ambients maps.
   */
  replaceHarmonyEnvironment(next: HarmonyEnvironmentState, reason = "harmonyEnvironment:replace"): void {
    const prev = this.state.harmonyEnvironment ?? { ...DEFAULT_ENV };

    const normalized: HarmonyEnvironmentState = normalizeEnv({
      colorId: next?.colorId,
      filterId: next?.filterId,
      particles: next?.particles ?? {},
      ambients: next?.ambients ?? {},
    });

    // No-op guard
    const same =
      prev.colorId === normalized.colorId &&
      prev.filterId === normalized.filterId &&
      JSON.stringify(prev.particles) === JSON.stringify(normalized.particles) &&
      JSON.stringify(prev.ambients) === JSON.stringify(normalized.ambients);

    if (same) return;

    this.update({ harmonyEnvironment: normalized }, reason);
  }

  /**
   * Re-announce the loaded state on the EventBus.
   * Useful for late subscribers (e.g. DebugOverlay bus log) and DEV diagnostics.
   */
  announceLoaded(): void {
    this.bus.emit<PersistenceLoadedPayload>("persistence:loaded", {
      state: this.getState(),
      fromSave: this.loadedFromSave,
    });
  }

  /** Update via top-level partial merge; schedules autosave by default. */
  update(partial: Partial<Omit<UserState, "version" | "createdAtMs" | "updatedAtMs">>, reason = "update"): void {
    const next: UserState = sanitizeState({
      ...this.state,
      ...partial,
      version: 1,
      createdAtMs: this.state.createdAtMs,
      updatedAtMs: nowMs(),
    } as UserState);

    this.state = next;

    this.bus.emit<PersistenceChangedPayload>("persistence:changed", {
      state: this.getState(),
      reason,
    });

    // Keep Harmony in sync any time persistence changes (cheap, and avoids “who emits first” issues)
    this.emitHarmonyPolicy(`persistence:changed:${reason}`);

    this.scheduleAutosave(reason);
  }

  /** Immediate, explicit save for critical moments (gate reopen, track unlock, etc.). */
  commit(reason = "commit"): void {
    this.clearAutosave();
    this.persistNow(reason, true);
  }

  // ---------------------------------------------------------------------------
  // Convenience getters
  // ---------------------------------------------------------------------------

  /** Returns the track state (clone-safe) or null if it doesn't exist in persistence. */
  getTrack(trackId: string): TrackState | null {
    const id = typeof trackId === "string" ? trackId : "";
    if (!id) return null;
    const t = this.state.tracks?.[id];
    return t ? safeClone(t) : null;
  }

  // ---------------------------------------------------------------------------
  // Convenience setters
  // ---------------------------------------------------------------------------

  setGateStatus(status: GateStatus, reason = "gate:setStatus"): void {
    const t = nowMs();
    const gate: GateState = {
      ...this.state.gate,
      status,
      lastOpenedAtMs: status === "open" ? t : this.state.gate.lastOpenedAtMs,
      lastClosedAtMs: status === "closed" ? t : this.state.gate.lastClosedAtMs,
      reopenCount:
        status === "open" && this.state.gate.status === "closed" ? this.state.gate.reopenCount + 1 : this.state.gate.reopenCount,
    };
    this.update({ gate }, reason);
  }

  setHarmonyMaster(volume01: number, reason = "harmony:master"): void {
    const harmony: HarmonyState = {
      ...this.state.harmony,
      masterVolume: clamp01(volume01),
    };
    this.update({ harmony }, reason);
  }

  setHarmonyLayer(layerId: string, volume01: number, muted: boolean, reason = "harmony:layer"): void {
    const layers = { ...this.state.harmony.layers };
    layers[layerId] = {
      id: layerId,
      volume: clamp01(volume01),
      muted: Boolean(muted),
    };
    const harmony: HarmonyState = {
      ...this.state.harmony,
      layers,
    };
    this.update({ harmony }, reason);
  }

  upsertTrack(trackId: string, partial: Partial<Omit<TrackState, "id">>, reason = "tracks:upsert"): void {
    const id = typeof trackId === "string" ? trackId : "";
    if (!id) return;

    const existing = this.state.tracks[id] ?? {
      id,
      unlocked: false,
      favorite: false,
      lastTimeSec: 0,
    };

    const tracks = { ...this.state.tracks };
    tracks[id] = {
      ...existing,
      ...partial,
      id,
      lastTimeSec: Number.isFinite(partial.lastTimeSec ?? existing.lastTimeSec)
        ? Math.max(0, partial.lastTimeSec ?? existing.lastTimeSec)
        : existing.lastTimeSec,
      favorite: typeof partial.favorite === "boolean" ? partial.favorite : existing.favorite,
      unlocked: typeof partial.unlocked === "boolean" ? partial.unlocked : existing.unlocked,
    };

    this.update({ tracks }, reason);
  }

  /** Phase 2: explicitly set favorite state (creates track entry if needed). */
  setTrackFavorite(trackId: string, favorite: boolean, reason = "tracks:setFavorite"): void {
    const id = typeof trackId === "string" ? trackId : "";
    if (!id) return;

    const existing = this.state.tracks[id] ?? {
      id,
      unlocked: false,
      favorite: false,
      lastTimeSec: 0,
    };

    if (existing.favorite === Boolean(favorite)) return;

    this.upsertTrack(id, { favorite: Boolean(favorite) }, reason);
  }

  /** Phase 2: toggle favorite (creates track entry if needed). */
  toggleTrackFavorite(trackId: string, reason = "tracks:toggleFavorite"): void {
    const id = typeof trackId === "string" ? trackId : "";
    if (!id) return;

    const existing = this.state.tracks[id] ?? {
      id,
      unlocked: false,
      favorite: false,
      lastTimeSec: 0,
    };

    this.upsertTrack(id, { favorite: !existing.favorite }, reason);
  }

  /** Phase 2: persist per-track resume position (creates track entry if needed). */
  setTrackLastTime(trackId: string, lastTimeSec: number, reason = "tracks:setLastTime"): void {
    const id = typeof trackId === "string" ? trackId : "";
    if (!id) return;
    this.upsertTrack(id, { lastTimeSec: clampNonNeg(lastTimeSec) }, reason);
  }

  setAudioPlayer(partial: Partial<AudioPlayerState>, reason = "audio:update"): void {
    const nextIsPlaying = typeof partial.isPlaying === "boolean" ? partial.isPlaying : this.state.audio.isPlaying;

    const nextTimeSec = Number.isFinite(partial.timeSec ?? NaN) ? Math.max(0, Number(partial.timeSec)) : this.state.audio.timeSec;

    const nextDurationSec =
      partial.durationSec === undefined
        ? this.state.audio.durationSec
        : partial.durationSec === null
          ? null
          : Number.isFinite(partial.durationSec)
            ? Math.max(0, Number(partial.durationSec))
            : this.state.audio.durationSec;

    const audio: AudioPlayerState = {
      ...this.state.audio,
      ...partial,

      activeTrackId:
        typeof partial.activeTrackId === "string" || partial.activeTrackId === null
          ? (partial.activeTrackId ?? null)
          : this.state.audio.activeTrackId,

      isPlaying: nextIsPlaying,
      timeSec: nextTimeSec,
      durationSec: nextDurationSec,

      volume: clamp01(partial.volume ?? this.state.audio.volume),
      repeat:
        partial.repeat === "one" || partial.repeat === "all" || partial.repeat === "off"
          ? (partial.repeat ?? this.state.audio.repeat)
          : this.state.audio.repeat,
    };

    this.update({ audio }, reason);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private emitHarmonyPolicy(reason: string): void {
    const payload: HarmonyPolicyPayload = {
      owner: this.state.owner,
      uiMode: this.state.uiMode,
      capabilities: safeClone(this.state.capabilityOverrides ?? {}),
      unlocks: safeClone(this.state.harmonyUnlocks ?? DEFAULT_UNLOCKS),
      source: "persistence",
      reason,
    };

    // IMPORTANT:
    //  - DO NOT emit "harmony:policy:set" here (Persistence listens to it).
    //  - Emit state/announce events only.
    this.bus.emit("harmony:policy:state", payload);
    this.bus.emit("harmony:ui:policy", payload);
  }

  private loadFromSave(): { state: UserState; fromSave: boolean } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = this.save.get(SAVE_KEY as any) as unknown;

    if (isUserStateV1(raw)) {
      // Back-compat: older saves may not have newer fields.
      const withExtras = raw as UserState;

      if (!(withExtras as any).harmonyEnvironment) {
        (withExtras as any).harmonyEnvironment = { ...DEFAULT_ENV };
      }

      if (typeof (withExtras as any).uiSfxEnabled !== "boolean") {
        (withExtras as any).uiSfxEnabled = false;
      }

      if ((withExtras as any).owner !== "director" && (withExtras as any).owner !== "lumen") {
        (withExtras as any).owner = "lumen";
      }

      if (
        (withExtras as any).uiMode !== "cinematic" &&
        (withExtras as any).uiMode !== "minimal" &&
        (withExtras as any).uiMode !== "full"
      ) {
        (withExtras as any).uiMode = "full";
      }

      if (!(withExtras as any).capabilityOverrides || typeof (withExtras as any).capabilityOverrides !== "object") {
        (withExtras as any).capabilityOverrides = {};
      }

      // Legacy migration: harmonyUnlocks may include colors. We normalize it away.
      if (!(withExtras as any).harmonyUnlocks) {
        (withExtras as any).harmonyUnlocks = { ...DEFAULT_UNLOCKS };
      }

      return { state: sanitizeState(withExtras), fromSave: true };
    }

    return { state: createDefaultState(), fromSave: false };
  }

  private scheduleAutosave(reason: string): void {
    if (this.autosaveDebounceMs === 0) {
      this.persistNow(reason, false);
      return;
    }

    this.clearAutosave();
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      this.persistNow(reason, false);
    }, this.autosaveDebounceMs);
  }

  private clearAutosave(): void {
    if (this.autosaveTimer == null) return;
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  private persistNow(reason: string, explicit: boolean): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.save.set(SAVE_KEY as any, this.state as any);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[PersistenceSystem] Failed to persist user state:", err);
      return;
    }

    this.bus.emit<PersistenceSavedPayload>("persistence:saved", {
      state: this.getState(),
      reason,
      explicit,
    });
  }

  /** Cleanup (Engine-owned). Cancels any pending debounced autosave. */
  dispose(): void {
    this.clearAutosave();
    this.bus.off("persistence:update-ui-sfx", this.onUiSfxUpdate);

    // NEW: Harmony contract offs
    this.bus.off("harmony:policy:request", this.onHarmonyPolicyRequest);
    this.bus.off("harmony:policy:set", this.onHarmonyPolicySet);
    this.bus.off("harmony:unlock:add", this.onHarmonyUnlockAdd);
    this.bus.off("harmony:dev:unlockAll", this.onHarmonyDevUnlockAll);
    this.bus.off("harmony:dev:toggleOwner", this.onHarmonyDevToggleOwner);
  }
}