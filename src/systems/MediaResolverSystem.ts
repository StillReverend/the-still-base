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
    // - Prefer explicit TrackCatalog URLs when present (lets you alias IDs like lift_alt -> lift.mp3)
    // - Also provide a DEV alias fallback for "/audio/*" -> `${devBasePath}/*`
    // - Fall back to conventional `${devBasePath}/${trackId}.{ext}` candidates
    const urls = this.getDevUrlCandidates(trackId, meta);

    this.emitResult({
      requestId,
      trackId,
      ok: true,
      urls,
    });
  }

  /**
   * DEV alias helper:
   * If TrackCatalog uses "/audio/foo.mp3" but DEV serves from devBasePath (e.g. "/assets/audio"),
   * provide a mapped fallback URL so AudioSystem can still load the file.
   */
  private mapDevAudioAlias(url: string): string | null {
    if (!url) return null;

    const u = url.trim();
    if (!u.startsWith("/audio/")) return null;

    const filename = u.split("/").pop() || "";
    if (!filename) return null;

    return `${this.devBasePath}/${filename}`;
  }

  private getDevUrlCandidates(trackId: string, meta?: ReturnType<typeof getTrackMeta>): string[] {
    const urls: string[] = [];

    // 1) TrackCatalog explicit urls (highest priority)
    // NOTE: TrackCatalog can store urls like "/audio/lift.mp3" or "/assets/audio/lift.mp3".
    // We accept absolute (http...), root-relative ("/...") and relative ("assets/...") paths.
    const metaUrls = (meta as any)?.urls as unknown;
    if (Array.isArray(metaUrls)) {
      for (const u of metaUrls) {
        if (typeof u !== "string") continue;
        const trimmed = u.trim();
        if (!trimmed) continue;

        // Original catalog URL
        urls.push(trimmed);

        // DEV alias fallback: "/audio/foo.mp3" -> `${devBasePath}/foo.mp3`
        const mapped = this.mapDevAudioAlias(trimmed);
        if (mapped) urls.push(mapped);
      }
    }

    // 2) Conventional candidates (so existing behavior still works)
    const id = trackId;
    const lower = trackId.toLowerCase();

    urls.push(`${this.devBasePath}/${id}.mp3`);
    urls.push(`${this.devBasePath}/${id}.m4a`);
    urls.push(`${this.devBasePath}/${id}.ogg`);

    if (lower !== id) {
      urls.push(`${this.devBasePath}/${lower}.mp3`);
      urls.push(`${this.devBasePath}/${lower}.m4a`);
      urls.push(`${this.devBasePath}/${lower}.ogg`);
    }

    // De-dupe + drop empties
    return Array.from(new Set(urls)).filter(Boolean);
  }

  private emitResult(res: MediaResolveResult): void {
    this.bus.emit("media:resolve:result", res);
  }
}
