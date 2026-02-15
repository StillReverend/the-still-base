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

export type HarmonyState = {
  uiVisible: boolean;
  vibePanelOpen: boolean;

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

  // vibe (Phase 1 placeholders)
  colorId: string | null;
  filterId: string | null;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;

  // ritual (scaffold)
  ritualDurationSec: number;
};

export const HARMONY_DEFAULT_STATE: HarmonyState = {
  uiVisible: true,
  vibePanelOpen: false,

  playing: false,
  trackId: null,
  title: "No track",
  positionSec: 0,
  durationSec: 0,

  shuffle: false,
  repeat: "off",
  volume: 0.85,

  colorId: null,
  filterId: null,
  particles: {},
  ambients: {},

  ritualDurationSec: 60,
};
