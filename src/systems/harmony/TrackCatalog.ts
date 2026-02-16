// src/systems/harmony/TrackCatalog.ts
// ============================================================
// THE STILL — Track Catalog (static metadata)
// ------------------------------------------------------------
// - Defines what tracks exist (ids + titles + kind)
// - Does NOT store URLs (resolver decides)
// ============================================================

export type TrackKind = "song" | "podcast" | "hidden";

export type TrackMeta = {
  id: string; // canonical id: "Lift"
  title: string; // display title
  kind: TrackKind;

  // Used for ordered playback in Repeat=All and non-shuffle sequencing
  order: number;

  // Bootstrap flag: allows a default ambient track to play on fresh installs
  // (Resolver may also persist unlocked=true the first time it sees this.)
  defaultUnlocked?: boolean;
};

// NOTE: Keep this list small for now. Add as you wire more.
const TRACKS: TrackMeta[] = [{ id: "Lift", title: "Lift", kind: "song", order: 1, defaultUnlocked: true }];

/**
 * Returns all tracks sorted by `order`.
 * (Repeat=All uses this as the canonical playlist order.)
 */
export const getAllTracks = (): TrackMeta[] => [...TRACKS].sort((a, b) => a.order - b.order);

/**
 * Returns metadata for a single trackId, or null if unknown.
 */
export const getTrackMeta = (trackId: string): TrackMeta | null => {
  const id = typeof trackId === "string" ? trackId : "";
  if (!id) return null;

  const t = TRACKS.find((x) => x.id === id);
  return t ?? null;
};
