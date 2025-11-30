// src/core/SaveManager.ts

import type { SceneName } from "../apps/SceneTypes";

const STORAGE_KEY = "the-still-save-v1";

export interface SaveData {
  lastScene?: SceneName;
}

export class SaveManager {
  private data: SaveData;

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as SaveData;
      return parsed || {};
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[SaveManager] Failed to load save data:", err);
      return {};
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[SaveManager] Failed to persist save data:", err);
    }
  }

  get<K extends keyof SaveData>(key: K): SaveData[K] {
    return this.data[key];
  }

  set<K extends keyof SaveData>(key: K, value: SaveData[K]): void {
    this.data[key] = value;
    this.persist();
  }

  clear(): void {
    this.data = {};
    this.persist();
  }
}

export const createSaveManager = (): SaveManager => new SaveManager();
