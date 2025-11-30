// src/apps/SceneTypes.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

// Keep this union in sync with our actual scenes
export type SceneName = "BootScene" | "DemoScene";

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  config: Config;
  bus: EventBus;
  save: SaveManager;
}

export interface SceneController {
  /** Unique identifier for the scene */
  readonly name: SceneName;

  /** Three.js Scene instance owned by this controller */
  readonly scene: THREE.Scene;

  /** Called once when the scene becomes active */
  init(ctx: SceneContext): void;

  /** Per-frame update while this scene is active */
  update(delta: number): void;

  /** Cleanup resources before switching away */
  dispose(): void;
}
