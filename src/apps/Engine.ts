// src/apps/Engine.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";
import { SceneManager } from "./SceneManager";
import type { SceneContext, SceneController, SceneName } from "./SceneTypes";
import { DebugOverlay } from "./DebugOverlay";

interface SceneSwitchPayload {
  name: SceneName;
}

export interface EngineDeps {
  canvas: HTMLCanvasElement;
  bus: EventBus;
  config: Config;
  save: SaveManager;
  initialSceneFactory: () => SceneController;
  resolveScene: (name: SceneName) => SceneController | null;
}

export class Engine {
  private readonly canvas: HTMLCanvasElement;
  private readonly bus: EventBus;
  private readonly config: Config;
  private readonly save: SaveManager;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sceneManager: SceneManager;
  private readonly resolveScene: (name: SceneName) => SceneController | null;

  private running = false;
  private lastTime = 0;

  private debugOverlay: DebugOverlay | null = null;

  constructor(deps: EngineDeps) {
    this.canvas = deps.canvas;
    this.bus = deps.bus;
    this.config = deps.config;
    this.save = deps.save;
    this.resolveScene = deps.resolveScene;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(this.config.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );

    this.sceneManager = new SceneManager(this.save);

    const ctx: SceneContext = {
      renderer: this.renderer,
      camera: this.camera,
      config: this.config,
      bus: this.bus,
      save: this.save,
    };
    this.sceneManager.attachContext(ctx);

    // Initial scene
    const initialScene = deps.initialSceneFactory();
    this.sceneManager.switchSceneImmediately(initialScene);

    // Listen for scene switch events
    this.bus.on<SceneSwitchPayload>("scene:switch", (payload) => {
      const next = this.resolveScene(payload.name);
      if (!next) {
        // eslint-disable-next-line no-console
        console.warn(`[Engine] No scene found for name "${payload.name}"`);
        return;
      }
      this.sceneManager.requestScene(next);
    });

    // Dev-only debug overlay
    if (import.meta.env.DEV) {
      this.debugOverlay = new DebugOverlay(this.camera);
    }

    window.addEventListener("resize", this.handleResize);
    this.handleResize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
  }

  private loop = (now: number): void => {
    if (!this.running) return;

    const dtRaw = (now - this.lastTime) / 1000;
    this.lastTime = now;

    const dt = Math.min(dtRaw, this.config.maxDeltaTime);

    this.sceneManager.update(dt);

    // Update debug HUD (dev only)
    if (this.debugOverlay) {
      this.debugOverlay.update(dt);
    }

    const current = this.sceneManager.getCurrentScene();
    if (current) {
      this.renderer.render(current.scene, this.camera);
    }

    requestAnimationFrame(this.loop);
  };

  private handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.handleResize);

    if (this.debugOverlay) {
      this.debugOverlay.dispose();
      this.debugOverlay = null;
    }

    this.renderer.dispose();
  }
}
