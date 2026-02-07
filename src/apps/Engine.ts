// src/apps/Engine.ts

import * as THREE from "three";

import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

import { SceneManager } from "./SceneManager";
import type { SceneContext, SceneController, SceneName } from "./SceneTypes";

import { DebugOverlay } from "./DebugOverlay";
import { DevTools } from "./DevTools";

import { CameraSystem } from "../systems/CameraSystem";
import { ControlSystem } from "../systems/ControlSystem";
import { PostFXSystem } from "../systems/PostFXSystem";
import { PersistenceSystem } from "../systems/PersistenceSystem";
import { GateSystem } from "../systems/GateSystem";
import { AudioSystem } from "../systems/AudioSystem";

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

  private readonly persistence: PersistenceSystem;
  private readonly gateSystem: GateSystem;
  private readonly audioSystem: AudioSystem;

  private readonly sceneManager: SceneManager;
  private readonly resolveScene: (name: SceneName) => SceneController | null;

  private running = false;
  private lastTime = 0;

  private debugOverlay: DebugOverlay | null = null;
  private devTools: DevTools | null = null;

  private lastRenderScene: THREE.Scene | null = null;

  // Resize jitter guard (mobile URL bar, subtle viewport “breathing”)
  private lastResizeW = -1;
  private lastResizeH = -1;
  private lastResizePR = -1;

  constructor(deps: EngineDeps) {
    this.canvas = deps.canvas;
    this.bus = deps.bus;
    this.config = deps.config;
    this.save = deps.save;
    this.resolveScene = deps.resolveScene;

    // Persistence (Engine-owned, canonical user state)
    this.persistence = new PersistenceSystem({
      bus: this.bus,
      save: this.save,
      autosaveDebounceMs: 750,
    });

    // Gate (local wall-clock midnight enforcement)
    this.gateSystem = new GateSystem(this.bus, this.persistence);

    // Audio (Phase 1)
    this.audioSystem = new AudioSystem({
      bus: this.bus,
      persistence: this.persistence,
      defaultFadeMs: 800,
    });

    // Renderer
    // ✅ OPAQUE CANVAS: removes “DOM background bleed” flashes.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });

    // ✅ Stable clear baseline
    this.renderer.setClearColor(0x000000, 1.0);

    this.renderer.setPixelRatio(this.config.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
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

    // DEV-only debug overlay + dev tools
    if (import.meta.env.DEV) {
      this.debugOverlay = new DebugOverlay(this.camera, this.bus);

      // DEV: re-announce persistence so late subscribers can see it in the bus log
      this.persistence.announceLoaded();

      // DEV: announce audio state after overlay subscribes
      this.audioSystem.announceState("engine:dev-overlay-ready");

      // Browser gesture unlock + (optional) dev autostart
      this.setupAudioUnlockGestures();
      this.setupAutoStartMusicOnFirstGesture("Legacy");

      this.devTools = new DevTools({
        bus: this.bus,
        postFX: this.postFX,
        overlay: this.debugOverlay as unknown as {
          isVisible?: () => boolean;
          setVisible?: (visible: boolean) => void;
          toggleVisible?: () => void;
        },
      });
    } else {
      // In PROD, we still need browser gesture unlock.
      this.setupAudioUnlockGestures();

      // If you want Lift.mp3 to start for real users too, keep this enabled.
      // If you prefer “silent until UI exists”, comment it out.
      this.setupAutoStartMusicOnFirstGesture("Legacy");
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

  /** Engine-level access to canonical persistent user state. */
  getPersistence(): PersistenceSystem {
    return this.persistence;
  }

  getGateSystem(): GateSystem {
    return this.gateSystem;
  }

  getAudioSystem(): AudioSystem {
    return this.audioSystem;
  }

  private loop = (now: number): void => {
    if (!this.running) return;

    const dtRaw = (now - this.lastTime) / 1000;
    this.lastTime = now;

    const dt = Math.min(dtRaw, this.config.maxDeltaTime);

    // Controls -> camera
    const snapshot = this.controlSystem.consumeSnapshot();
    this.cameraSystem.applyControlDeltas(snapshot.rotateDelta, snapshot.dollyDelta);
    this.cameraSystem.update(dt);

    // Gate system (local wall-clock)
    this.gateSystem.update(dt);

    // Audio
    this.audioSystem.update(dt);

    // Scene update
    this.sceneManager.update(dt);

    // Debug overlay (dev only)
    if (this.debugOverlay) {
      this.debugOverlay.update(dt);
    }

    // Optional dev log: dt spikes often correlate with “pop” moments
    if (import.meta.env.DEV && dtRaw > 0.05) {
      // eslint-disable-next-line no-console
      console.log(`[Perf] dt spike: ${dtRaw.toFixed(3)}s (clamped to ${dt.toFixed(3)}s)`);
    }

    // Render (PostFX owns rendering)
    const current = this.sceneManager.getCurrentScene();
    if (current) {
      if (this.lastRenderScene !== current.scene) {
        this.postFX.setTargets(current.scene, this.camera);
        this.lastRenderScene = current.scene;
      }

      this.postFX.update(dt);
      this.postFX.render();
    }

    requestAnimationFrame(this.loop);
  };

  private handleResize = (): void => {
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight);

    const dpr = window.devicePixelRatio || 1;

    // ✅ Keep this conservative for stability
    const pr = Math.min(dpr, 1.0);

    const ignorePx = 1;
    const wChanged = Math.abs(w - this.lastResizeW) > ignorePx;
    const hChanged = Math.abs(h - this.lastResizeH) > ignorePx;
    const prChanged = Math.abs(pr - this.lastResizePR) > 0.001;

    if (!wChanged && !hChanged && !prChanged) return;

    this.lastResizeW = w;
    this.lastResizeH = h;
    this.lastResizePR = pr;

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);

    // ✅ Always re-assert opaque clear after resize
    this.renderer.setClearColor(0x000000, 1.0);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.postFX.resize(w, h, pr);
  };

  // ---------------------------------------------------------------------------
  // Audio unlock (browser gesture)
  // ---------------------------------------------------------------------------

  private audioUnlockArmed = false;

  /**
   * Browsers require a user gesture to start audio. We arm a one-time gesture
   * listener that requests unlock on first pointer/key interaction.
   */
  private setupAudioUnlockGestures(): void {
    if (this.audioUnlockArmed) return;
    this.audioUnlockArmed = true;

    const fire = (): void => {
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
      this.bus.emit("audio:unlock-request", {});
    };

    window.addEventListener("pointerdown", fire, { once: true });
    window.addEventListener("keydown", fire, { once: true });
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Auto-start a background track on first gesture
  // ---------------------------------------------------------------------------

  private autoStartMusicArmed = false;

  /**
   * Starts a named track (e.g. "Lift") after the first user gesture.
   * We wait for "audio:unlocked" before requesting play to avoid races.
   */
  private setupAutoStartMusicOnFirstGesture(trackId: string): void {
    if (this.autoStartMusicArmed) return;
    this.autoStartMusicArmed = true;

    let fired = false;

    const fire = (): void => {
      if (fired) return;
      fired = true;

      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);

      // Set track immediately (id is used to resolve Lift.mp3).
      this.bus.emit("audio:set-track", { trackId });

      // Once unlocked, request play.
      const onUnlocked = (): void => {
        this.bus.off("audio:unlocked", onUnlocked as unknown as (payload: unknown) => void);
        this.bus.emit("audio:play-request", {});
      };

      // If we’re already unlocked for some reason, just play.
      const state = this.audioSystem.getState();
      if (state.isUnlocked) {
        this.bus.emit("audio:play-request", {});
        return;
      }

      // Wait for unlock completion.
      this.bus.on("audio:unlocked", onUnlocked as unknown as (payload: unknown) => void);

      // Trigger unlock.
      this.bus.emit("audio:unlock-request", {});
    };

    window.addEventListener("pointerdown", fire, { once: true });
    window.addEventListener("keydown", fire, { once: true });
  }

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.handleResize);

    if (this.devTools) {
      this.devTools.dispose();
      this.devTools = null;
    }

    if (this.debugOverlay) {
      this.debugOverlay.dispose();
      this.debugOverlay = null;
    }

    // Audio: detach bus handlers
    this.audioSystem.dispose();

    // Persistence: cancel any pending autosave timers
    this.gateSystem.dispose();
    this.persistence.dispose();

    this.controlSystem.dispose();
    this.postFX.dispose();
    this.renderer.dispose();
  }
}
