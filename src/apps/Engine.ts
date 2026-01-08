// src/apps/Engine.ts

import * as THREE from "three";

import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

import { SceneManager } from "./SceneManager";
import type { SceneContext, SceneController, SceneName } from "./SceneTypes";

import { DebugOverlay } from "./DebugOverlay";
import { CameraSystem } from "../systems/CameraSystem";
import { ControlSystem } from "../systems/ControlSystem";
import { PostFXSystem } from "../systems/PostFXSystem";

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
  private readonly postFX: PostFXSystem;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly cameraSystem: CameraSystem;
  private readonly controlSystem: ControlSystem;

  private readonly sceneManager: SceneManager;
  private readonly resolveScene: (name: SceneName) => SceneController | null;

  private running = false;
  private lastTime = 0;

  private debugOverlay: DebugOverlay | null = null;

  private lastRenderScene: THREE.Scene | null = null;

  constructor(deps: EngineDeps) {
    this.canvas = deps.canvas;
    this.bus = deps.bus;
    this.config = deps.config;
    this.save = deps.save;
    this.resolveScene = deps.resolveScene;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(this.config.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      1.0,
      1000,
    );

    this.cameraSystem = new CameraSystem({
      camera: this.camera,
      bus: this.bus,
      config: this.config,
    });

    this.controlSystem = new ControlSystem({
      domElement: this.canvas,
      bus: this.bus,
      config: this.config,
    });

    // Scene manager
    this.sceneManager = new SceneManager(this.save);

    // PostFX pipeline (Engine-owned, single instance for the whole app).
    // Seed with a placeholder scene; we’ll retarget to the real scene after switching.
    this.postFX = new PostFXSystem({
      renderer: this.renderer,
      scene: new THREE.Scene(),
      camera: this.camera,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: this.config.pixelRatio,
      settings: {
        enabled: true,
        bloom: {
          enabled: true,
          strength: 1.05,
          radius: 0.55,
          threshold: 0.12,
        },
      },
    });

    // Attach shared context (includes postFX)
    const ctx: SceneContext = {
      renderer: this.renderer,
      camera: this.camera,
      config: this.config,
      bus: this.bus,
      save: this.save,
      postFX: this.postFX,
    };
    this.sceneManager.attachContext(ctx);

    // Initial scene
    const initialScene = deps.initialSceneFactory();
    this.sceneManager.switchSceneImmediately(initialScene);

    // Ensure PostFX targets the active scene immediately
    const current = this.sceneManager.getCurrentScene();
    if (current) {
      this.postFX.setTargets(current.scene, this.camera);
      this.lastRenderScene = current.scene;
    }

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
      this.debugOverlay = new DebugOverlay(this.camera, this.bus);
    }

    if (import.meta.env.DEV) {
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "b") {
      const s = this.postFX.getSettings();
      this.postFX.setBloomEnabled(!s.bloom.enabled);
      // eslint-disable-next-line no-console
      console.log(`[Dev] Bloom ${!s.bloom.enabled ? "ON" : "OFF"}`);
    }

    if (e.key.toLowerCase() === "p") {
      const s = this.postFX.getSettings();
      this.postFX.setEnabled(!s.enabled);
      // eslint-disable-next-line no-console
      console.log(`[Dev] PostFX ${!s.enabled ? "ON" : "OFF"}`);
    }
  });
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

    const snapshot = this.controlSystem.consumeSnapshot();
    this.cameraSystem.applyControlDeltas(snapshot.rotateDelta, snapshot.dollyDelta);
    this.cameraSystem.update(dt);

    this.sceneManager.update(dt);

    // Update debug HUD (dev only)
    if (this.debugOverlay) {
      this.debugOverlay.update(dt);
    }

    const current = this.sceneManager.getCurrentScene();
    if (current) {
      if (this.lastRenderScene !== current.scene) {
        this.postFX.setTargets(current.scene, this.camera);
        this.lastRenderScene = current.scene;
      }
      this.postFX.render();
    }

    requestAnimationFrame(this.loop);
  };

  // IMPORTANT:
  // Renderer + PostFX must share the SAME capped pixel ratio.
  // Higher DPR causes bloom threshold shimmer in fullscreen (Solar mode).
  // pr=1.0 is intentional and stable.

  private handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const dpr = window.devicePixelRatio || 1;

    // ✅ Known-good anti-flicker cap (start here)
    const pr = Math.min(dpr, 1.0);

    // Renderer + PostFX must agree on pixel ratio to prevent shimmer
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.postFX.resize(w, h, pr);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.handleResize);

    if (this.debugOverlay) {
      this.debugOverlay.dispose();
      this.debugOverlay = null;
    }

    this.controlSystem.dispose();
    this.postFX.dispose();
    this.renderer.dispose();
  }
}
