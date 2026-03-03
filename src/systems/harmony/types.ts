// src/systems/harmony/types.ts
// ============================================================
// THE STILL — Harmony (Contracts)
// ============================================================
//
// IMPORTANT:
// Harmony must not import AudioSystem directly.
// It only speaks through EventBus contracts.
// So we define the minimal AudioSystemState shape we care about here,
// and we import RepeatMode from PersistenceSystem (canonical/persisted).
// ============================================================

import type { RepeatMode } from "../PersistenceSystem";

export type AudioCmdSource = "harmony" | string;

/**
 * AudioSystemState (subset Harmony cares about).
 * This mirrors what AudioSystem emits inside `audio:state`.
 */
export type AudioSystemState = {
  activeTrackId: string | null;
  isPlaying: boolean;

  timeSec: number;
  durationSec: number | null;

  shuffle: boolean;
  repeat: RepeatMode;

  volume: number; // 0..1

  effectiveVolume: number; // 0..1
  systemMuted: boolean;

  isUnlocked: boolean;
  lastError: string | null;
};

/**
 * The ONLY supported payload shape for `audio:state`.
 * AudioSystem emits: { state: AudioSystemState, reason: string }
 */
export type AudioStateEvent = {
  state: AudioSystemState;
  reason: string;

  /**
   * Optional UI-friendly title override (future).
   * If omitted, Harmony will show trackId or "No track".
   */
  title?: string;
};

export type AudioCatalog = {
  tracks: Array<{
    id: string;
    title: string;
    durationSec?: number;
    kind?: "song" | "podcast" | "track";
    locked?: boolean;
    favorite?: boolean;
  }>;
  activeTrackId?: string | null;
};

/**
 * HarmonyMixState
 * ------------------------------------------------------------
 * Volume lanes for HowlerAudioSystem (and later: AudioSystem too).
 * These are UI-facing values; actual routing is handled by systems.
 */
export type HarmonyMixState = {
  master: number; // 0..1
  music: number; // 0..1
  sfx: number; // 0..1
  ambient: number; // 0..1
  ui: number; // 0..1
};

// ============================================================
// Ownership, UI Modes, Capabilities, Unlocks
// ============================================================

export type HarmonyOwner = "director" | "lumen";

export type HarmonyUIMode = "cinematic" | "minimal" | "full";

/**
 * Capabilities are an allow-list of actions.
 * Systems can gate "intent" events; UI can render locked/disabled controls.
 */
export type HarmonyCapability =
  // Core playback UX
  | "playback.basic" // play/pause + seek
  | "playback.transport" // prev/next
  | "playback.shuffle"
  | "playback.repeat"
  // Environment
  | "env.panel" // can open the environment panel
  | "env.filters"
  | "env.particles"
  | "env.ambients"
  | "env.presets"
  // Mix
  | "mix.lanes" // can change any lane sliders
  // UI meta
  | "ui.hide"; // can hide the whole UI

export type HarmonyCapabilities = Partial<Record<HarmonyCapability, boolean>>;

/**
 * Persistent unlocks collected during the director-led path.
 * Kept as simple ID maps for easy merging + serialization.
 */
export type HarmonyUnlocks = {
  filters: Record<string, boolean>;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
  presets: Record<string, boolean>;
};

export const HARMONY_DEFAULT_CAPABILITIES: HarmonyCapabilities = {
  // By default, "full" experience is allowed unless a system overrides.
  "playback.basic": true,
  "playback.transport": true,
  "playback.shuffle": true,
  "playback.repeat": true,

  "env.panel": true,
  "env.filters": true,
  "env.particles": true,
  "env.ambients": true,
  "env.presets": true,

  "mix.lanes": true,
  "ui.hide": true,
};

export const HARMONY_DEFAULT_UNLOCKS: HarmonyUnlocks = {
  filters: {},
  particles: {},
  ambients: {},
  presets: {},
};

/**
 * HarmonyPolicy
 * ------------------------------------------------------------
 * A compact "director vs lumen" policy surface that can be applied/merged.
 * Useful for EventBus payloads and persistence.
 */
export type HarmonyPolicy = {
  owner?: HarmonyOwner;
  uiMode?: HarmonyUIMode;
  capabilities?: HarmonyCapabilities;
  unlocks?: Partial<HarmonyUnlocks>;
};

export type HarmonyState = {
  uiVisible: boolean;
  environmentPanelOpen: boolean;

  // Ownership + UI mode + capability gating + collected unlocks
  owner: HarmonyOwner; // "director" (Reverend Path) | "lumen" (post-path)
  uiMode: HarmonyUIMode; // cinematic/minimal/full
  capabilities: HarmonyCapabilities; // allow-list
  unlocks: HarmonyUnlocks; // collected content

  // audio (from audio:state)
  playing: boolean;
  trackId: string | null;
  title: string;
  positionSec: number;
  durationSec: number;

  // player controls (Phase 1)
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number; // 0..1

  // environment (Phase 1 canonical placeholders)
  // These mirror HarmonyEnvironmentSystem snapshots.
  filterId: string | null;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;

  // ritual (scaffold)
  ritualDurationSec: number;

  // mixer lanes (Howler + future audio routing)
  mix: HarmonyMixState;
};

export const HARMONY_DEFAULT_STATE: HarmonyState = {
  uiVisible: true,
  environmentPanelOpen: false,

  owner: "lumen",
  uiMode: "full",
  capabilities: { ...HARMONY_DEFAULT_CAPABILITIES },
  // ✅ Use canonical default constant (and keep the shape stable)
  unlocks: { ...HARMONY_DEFAULT_UNLOCKS },

  playing: false,
  trackId: null,
  title: "No track",
  positionSec: 0,
  durationSec: 0,

  shuffle: false,
  repeat: "off",
  volume: 0.85,

  // Match HarmonyEnvironmentSystem defaults (f1)
  filterId: "f1",
  particles: {},
  ambients: {},

  ritualDurationSec: 60,

  // Sensible defaults (matches HowlerAudioSystem defaults you shared)
  mix: {
    master: 1.0,
    music: 1.0,
    sfx: 0.85,
    ambient: 0.7,
    ui: 0.6,
  },
};

// ============================================================
// Optional: Event payload shapes for policy control (EventBus)
// ------------------------------------------------------------
// These are "contracts" only; no EventBus imports.
// ============================================================

export type HarmonyPolicySetEvent = {
  policy: HarmonyPolicy;
  reason?: string;
  source?: string;
};

export type HarmonyPolicyPatchEvent = {
  patch: HarmonyPolicy;
  reason?: string;
  source?: string;
};

export type HarmonyUnlockEvent = {
  kind: keyof HarmonyUnlocks; // filters | particles | ambients | presets
  id: string;
  enabled?: boolean; // default true
  reason?: string;
  source?: string;
};