// src/systems/harmony/types.ts
// ============================================================
// THE STILL — Harmony (Contracts)
// ============================================================

export type RepeatMode = "off" | "one" | "all";
export type AudioCmdSource = "harmony" | string;

export type AudioState = {
  playing: boolean;
  trackId: string | null;
  title?: string;
  positionSec: number;
  durationSec: number;
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

  colorId: null,
  filterId: null,
  particles: {},
  ambients: {},

  ritualDurationSec: 60,
};
