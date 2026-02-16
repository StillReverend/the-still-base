// src/systems/MediaResolverSystem.ts
// ============================================================
// THE STILL — MediaResolverSystem (EventBus)
// ------------------------------------------------------------
// - Resolves playable URLs for a trackId
// - Enforces locked/unlocked
// - Future: signed URLs + auth + entitlement checks
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PersistenceSystem } from "./PersistenceSystem";
import { getTrackMeta } from "./harmony/TrackCatalog";

export type MediaResolveRequest = {
  requestId: string;
  trackId: string;
  purpose: "decode" | "duration";
};

export type MediaResolveResult = {
  requestId: string;
  trackId: string;
  ok: boolean;
  urls?: string[];
  error?: string;
};

type AnyFn = (payload: any) => void;

export interface MediaResolverSystemDeps {
  bus: EventBus;
  persistence: PersistenceSystem;

  /**
   * DEV: base path for local audio assets.
   * In PROD we’ll replace this with signed URL resolution.
   */
  devBasePath?: string; // default "/assets/audio"
}

export class MediaResolverSystem {
  private readonly bus: EventBus;
  private readonly persistence: PersistenceSystem;
  private readonly devBasePath: string;

  private disposers: Array<() => void> = [];

  constructor(deps: MediaResolverSystemDeps) {
    this.bus = deps.bus;
    this.persistence = deps.persistence;
    this.devBasePath = deps.devBasePath ?? "/assets/audio";
  }

  init(): void {
    const onResolve: AnyFn = (p: MediaResolveRequest) => this.handleResolve(p);
    this.bus.on("media:resolve", onResolve);
    this.disposers.push(() => this.bus.off("media:resolve", onResolve));
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private handleResolve(p: MediaResolveRequest): void {
    const requestId = typeof p?.requestId === "string" ? p.requestId : "";
    const trackId = typeof p?.trackId === "string" ? p.trackId : "";

    if (!requestId || !trackId) {
      this.emitResult({
        requestId,
        trackId,
        ok: false,
        error: "Invalid media:resolve request payload.",
      });
      return;
    }

    const meta = getTrackMeta(trackId);
    if (!meta) {
      this.emitResult({
        requestId,
        trackId,
        ok: false,
        error: `Unknown trackId "${trackId}" (not in TrackCatalog).`,
      });
      return;
    }

    // Enforce unlock state via Persistence
    const user = this.persistence.getState();
    const existing = user.tracks?.[trackId];

    const isUnlocked = Boolean(existing?.unlocked) || Boolean(meta.defaultUnlocked);

    // If this track is catalog-default and not yet in persistence, bootstrap it
    if (meta.defaultUnlocked && !existing) {
      this.persistence.upsertTrack(trackId, { unlocked: true }, "tracks:bootstrap-defaultUnlocked");
      // This is a “critical” moment if you want it locked in immediately:
      this.persistence.commit("tracks:bootstrap-defaultUnlocked");
    }

    if (!isUnlocked) {
      this.emitResult({
        requestId,
        trackId,
        ok: false,
        error: `Track "${trackId}" is locked.`,
      });
      return;
    }

    // DEV URL candidates
    // We return multiple candidates so you can change extensions/paths later without touching AudioSystem.
    const urls = this.getDevUrlCandidates(trackId);

    this.emitResult({
      requestId,
      trackId,
      ok: true,
      urls,
    });
  }

  private getDevUrlCandidates(trackId: string): string[] {
    const id = trackId;
    const lower = trackId.toLowerCase();

    const urls: string[] = [];
    urls.push(`${this.devBasePath}/${id}.mp3`);
    urls.push(`${this.devBasePath}/${id}.m4a`);
    urls.push(`${this.devBasePath}/${id}.ogg`);

    if (lower !== id) {
      urls.push(`${this.devBasePath}/${lower}.mp3`);
      urls.push(`${this.devBasePath}/${lower}.m4a`);
      urls.push(`${this.devBasePath}/${lower}.ogg`);
    }

    // De-dupe
    return Array.from(new Set(urls));
  }

  private emitResult(res: MediaResolveResult): void {
    this.bus.emit("media:resolve:result", res);
  }
}
