// src/systems/harmony/types.ts
// ============================================================
// THE STILL — Harmony (Contracts)
// ============================================================

export type RepeatMode = "off" | "one" | "all";
export type AudioCmdSource = "harmony" | string;

export type AudioState = {
  // Harmony-friendly / legacy shapes
  playing?: boolean;
  trackId?: string | null;
  title?: string;
  positionSec?: number;
  durationSec?: number;

  // AudioSystemState-ish shapes
  isPlaying?: boolean;
  activeTrackId?: string | null;
  timeSec?: number;
  durationSecRaw?: number;
  repeat?: RepeatMode;
  shuffle?: boolean;
  volume?: number;

  // optional extras (future)
  repeatMode?: RepeatMode;
  isFavorite?: boolean;
  locked?: boolean;
  bufferedSec?: number;
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
