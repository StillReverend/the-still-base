// src/apps/SceneManager.ts

import type { SceneController, SceneContext } from "./SceneTypes";
import type { SaveManager } from "../core/SaveManager";

export class SceneManager {
  private ctx: SceneContext | null = null;
  private current: SceneController | null = null;
  private pending: SceneController | null = null;
  private initializedScenes = new Set<SceneController>();
  private readonly save: SaveManager;

  constructor(save: SaveManager) {
    this.save = save;
  }

  attachContext(ctx: SceneContext): void {
    this.ctx = ctx;
  }

  getCurrentScene(): SceneController | null {
    return this.current;
  }

  /** Queue a new scene to become active on the next update tick */
  requestScene(next: SceneController): void {
    this.pending = next;
  }

  /** Hard switch immediately (used rarely; requestScene is safer) */
  switchSceneImmediately(next: SceneController): void {
    if (!this.ctx) {
      // eslint-disable-next-line no-console
      console.warn("[SceneManager] Cannot switch scene before context attached.");
      return;
    }

    if (this.current) {
      this.current.dispose();
      this.initializedScenes.delete(this.current);
    }

    this.current = next;

    if (!this.initializedScenes.has(next)) {
      next.init(this.ctx);
      this.initializedScenes.add(next);
    }

    // Persist the active scene name
    this.save.set("lastScene", next.name);
  }

  update(delta: number): void {
    if (!this.ctx) return;

    if (this.pending) {
      this.switchSceneImmediately(this.pending);
      this.pending = null;
    }

    if (this.current) {
      this.current.update(delta);
    }
  }
}
