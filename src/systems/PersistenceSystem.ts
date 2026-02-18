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

export interface UserState {
  /** Schema version for migrations. */
  version: 1;

  gate: GateState;
  player: PlayerState;

  harmony: HarmonyState;
  audio: AudioPlayerState;

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
      lastOpenedAtMs: Number.isFinite(state.gate?.lastOpenedAtMs ?? NaN)
        ? (state.gate.lastOpenedAtMs as number)
        : null,
      lastClosedAtMs: Number.isFinite(state.gate?.lastClosedAtMs ?? NaN)
        ? (state.gate.lastClosedAtMs as number)
        : null,
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

export class PersistenceSystem {
  private readonly bus: EventBus;
  private readonly save: SaveManagerAny;

  private readonly autosaveDebounceMs: number;
  private autosaveTimer: number | null = null;

  private state: UserState;
  private loadedFromSave: boolean;

  constructor(deps: PersistenceSystemDeps) {
    this.bus = deps.bus;
    this.save = deps.save as SaveManagerAny;
    this.autosaveDebounceMs = Math.max(0, deps.autosaveDebounceMs ?? 750);

    const loaded = this.loadFromSave();
    this.state = loaded.state;
    this.loadedFromSave = loaded.fromSave;

    this.bus.emit<PersistenceLoadedPayload>("persistence:loaded", {
      state: this.getState(),
      fromSave: this.loadedFromSave,
    });
  }

  /** Returns a deep-ish copy safe for consumers (no mutation). */
  getState(): UserState {
    return safeClone(this.state);
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
        status === "open" && this.state.gate.status === "closed"
          ? this.state.gate.reopenCount + 1
          : this.state.gate.reopenCount,
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

  private loadFromSave(): { state: UserState; fromSave: boolean } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = this.save.get(SAVE_KEY as any) as unknown;

    if (isUserStateV1(raw)) {
      return { state: sanitizeState(raw), fromSave: true };
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
  }
}
