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
import { CameraDirectorSystem } from "../systems/CameraDirectorSystem";
import { ControlSystem } from "../systems/ControlSystem";
import { PostFXSystem } from "../systems/PostFXSystem";
import { PersistenceSystem } from "../systems/PersistenceSystem";
import { GateSystem } from "../systems/GateSystem";
import { AudioSystem } from "../systems/AudioSystem";
import { HowlerAudioSystem } from "../systems/HowlerAudioSystem";
import { InteractionSystem } from "../systems/InteractionSystem";
import { HarmonySystem } from "../systems/harmony/HarmonySystem";
import { HarmonyEnvironmentSystem } from "../systems/harmony/HarmonyEnvironmentSystem";
import { HarmonyPresetsSystem } from "../systems/harmony/HarmonyPresetsSystem";
import { HarmonyAmbientSystem } from "../systems/harmony/HarmonyAmbientSystem";
import { MediaResolverSystem } from "../systems/MediaResolverSystem";
import { ParticleFXSystem } from "../systems/ParticleFXSystem";

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
  private readonly cameraDirector: CameraDirectorSystem;
  private readonly controlSystem: ControlSystem;

  private readonly persistence: PersistenceSystem;

  private readonly mediaResolver: MediaResolverSystem;

  private readonly gateSystem: GateSystem;
  private readonly audioSystem: AudioSystem;
  private readonly howlerAudioSystem: HowlerAudioSystem;
  private readonly interactionSystem: InteractionSystem;

  private harmony: HarmonySystem | null = null;
  private harmonyEnvironment: HarmonyEnvironmentSystem | null = null;
  private harmonyPresets: HarmonyPresetsSystem | null = null;
  private harmonyAmbients: HarmonyAmbientSystem | null = null;

  private readonly particleFX: ParticleFXSystem;

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

  // ✅ Keep a stable reference so we can unbind on dispose (HMR-safe)
  private readonly onSceneSwitch: (payload: SceneSwitchPayload) => void;

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

    // Media resolver (Engine-owned)
    this.mediaResolver = new MediaResolverSystem({
      bus: this.bus,
      persistence: this.persistence,
      devBasePath: "/assets/audio",
    });
    this.mediaResolver.init();

    // Gate (local wall-clock midnight enforcement)
    this.gateSystem = new GateSystem(this.bus, this.persistence);

    // Audio (Phase 1)
    this.audioSystem = new AudioSystem({
      bus: this.bus,
      persistence: this.persistence,
      defaultFadeMs: 800,
    });

    // Howler (Playback-first: SFX + Ambient now; music later)
    this.howlerAudioSystem = new HowlerAudioSystem({
      bus: this.bus,
      basePath: "/assets/audio",
      startMuted: false,
      volumes: {
        master: 1.0,
        sfx: 0.85,
        ambient: 0.7,
        music: 1.0,
        ui: 0.6,
      },
    });

    // ------------------------------------------------------------
    // ✅ Boot sync: UI SFX enable (persisted) -> HowlerAudioSystem
    // ------------------------------------------------------------
    // Now that Harmony has sliders, we want UI sounds ON by default,
    // but still fully user-controllable and persisted.
    const userState = this.persistence.getState();

    // Default ON unless the user explicitly turned it off.
    const uiSfxEnabled = (userState as any)?.uiSfxEnabled !== false;

    this.bus.emit("howler:ui-sfx:set-enabled", {
      enabled: uiSfxEnabled,
      source: "engine:boot",
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

    // ✅ Lock renderer color pipeline (stable)
    // Keep this.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ✅ Punchy legacy baseline (more dynamic pop than ACES)
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.renderer.setPixelRatio(this.config.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1.0, 1000);

    this.cameraSystem = new CameraSystem({
      camera: this.camera,
      bus: this.bus,
      config: this.config,
    });

    // Camera Director (cinematic shots)
    this.cameraDirector = new CameraDirectorSystem({
      bus: this.bus,
      cameraSystem: this.cameraSystem,
    });

    this.controlSystem = new ControlSystem({
      domElement: this.canvas,
      bus: this.bus,
      config: this.config,
    });

    // Interaction (central pointer + raycast)
    this.interactionSystem = new InteractionSystem({
      bus: this.bus,
      domElement: this.renderer.domElement,
      camera: this.camera,
    });

    // PostFX pipeline (Engine-owned, single instance for the whole app).
    // Seed with a placeholder scene; we’ll retarget to the real scene after switching.
    this.postFX = new PostFXSystem({
      renderer: this.renderer,
      scene: new THREE.Scene(),
      camera: this.camera,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: this.config.pixelRatio,

      // ✅ Pass bus so PostFX can listen for:
      //  - "postfx:audio-energy" (impact/transient)
      //  - "postfx:impulse" (gongs)
      //  - "postfx:ritual" (hold ramp)
      bus: this.bus,

      settings: {
        enabled: true,
        bloom: {
          enabled: true,

          // ✅ Starfield presence restore:
          // Lower threshold so small bright points actually contribute to bloom.
          threshold: 0.02,

          // Slightly hotter baseline. We can tune after A/B.
          strength: 1.25,
          radius: 0.65,
        },
      },
    });

    // ✅ NEW: ParticleFX (Engine-owned, bus-driven, scene-retargeted)
    this.particleFX = new ParticleFXSystem({ bus: this.bus });
    this.particleFX.init();

    // ✅ Harmony Environment (canonical vibe/persistence + PostFX apply)
    // Must be created AFTER PostFX and Persistence exist.
    this.harmonyEnvironment = new HarmonyEnvironmentSystem({
      bus: this.bus,
      persistence: this.persistence,
      postFX: this.postFX,
    });
    this.harmonyEnvironment.init();

    // ✅ Harmony Presets (MVP buttons)
    // Bus-only: emits a full snapshot; EnvironmentSystem performs overwrite apply.
    this.harmonyPresets = new HarmonyPresetsSystem(this.bus);
    this.harmonyPresets.init();

    // ✅ Harmony Ambients (Phase 1.1)
    // Listens to harmony:environment:* snapshots and commands Howler ambient loops.
    this.harmonyAmbients = new HarmonyAmbientSystem(this.bus);
    this.harmonyAmbients.init();

    // ✅ Boot-sync handshake:
    // Environment emitted "boot" before ambients subscribed; request a fresh snapshot now.
    this.bus.emit("harmony:environment:requestState", { source: "engine:post-ambients-init" });

    // ✅ Harmony UI/System should be created AFTER env systems are online,
    // so it can immediately mirror canonical environment state.
    this.harmony = new HarmonySystem(this.bus);
    this.harmony.init();

    // Scene manager
    this.sceneManager = new SceneManager(this.save);

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

    // Ensure PostFX + ParticleFX target the active scene immediately
    const current = this.sceneManager.getCurrentScene();
    if (current) {
      this.postFX.setTargets(current.scene, this.camera);
      this.lastRenderScene = current.scene;

      // ✅ ParticleFX retarget on scene switch
      this.particleFX.setTargets(current.scene, this.camera);

    }

    // ✅ Scene switch handler (stored for cleanup)
    this.onSceneSwitch = (payload: SceneSwitchPayload) => {
      const next = this.resolveScene(payload.name);
      if (!next) {
        // eslint-disable-next-line no-console
        console.warn(`[Engine] No scene found for name "${payload.name}"`);
        return;
      }
      this.sceneManager.requestScene(next);
    };

    // Listen for scene switch events
    this.bus.on<SceneSwitchPayload>("scene:switch", this.onSceneSwitch);

    // DEV-only debug overlay + dev tools
    if (import.meta.env.DEV) {
      this.debugOverlay = new DebugOverlay(this.camera, this.bus);

      // DEV: re-announce persistence so late subscribers can see it in the bus log
      this.persistence.announceLoaded();

      // DEV: announce audio state after overlay subscribes
      this.audioSystem.announceState("engine:dev-overlay-ready");

      // Browser gesture unlock + (optional) dev autostart
      this.setupAudioUnlockGestures();
      //this.setupAutoStartMusicOnFirstUnlock("Lift");

      // DEV: expose bus for quick console testing
      (window as any).__STILL_BUS__ = this.bus;

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
      //this.setupAutoStartMusicOnFirstUnlock("Lift");
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

    // Controls -> camera (CameraSystem will ignore if a cinematic is active)
    const snapshot = this.controlSystem.consumeSnapshot();
    this.cameraSystem.applyControlDeltas(snapshot.rotateDelta, snapshot.dollyDelta);

    // Camera Director (cinematics) updates BEFORE the rig update
    this.cameraDirector.update(dt);

    // Camera rig update (auto-orbit, damping, telemetry, etc.)
    this.cameraSystem.update(dt);

    // Gate system (local wall-clock)
    this.gateSystem.update(dt);

    // Audio
    this.audioSystem.update(dt);
    this.howlerAudioSystem.update(dt);

    // Interaction
    this.interactionSystem.update(dt);

    // Scene update
    this.sceneManager.update(dt);

    // ✅ ParticleFX update
    this.particleFX.update(dt);

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

        // ✅ ParticleFX retarget
        this.particleFX.setTargets(current.scene, this.camera);

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
  // Phase 1: Auto-start a background track after unlock
  // ---------------------------------------------------------------------------

  private autoStartMusicArmed = false;

  /**
   * Starts a named track (e.g. "Lift") once audio becomes unlocked.
   *
   * IMPORTANT:
   * - Does NOT attach its own gesture listeners.
   * - Piggybacks on setupAudioUnlockGestures() which already handles the first gesture.
   */
  private setupAutoStartMusicOnFirstUnlock(trackId: string): void {
    if (this.autoStartMusicArmed) return;
    this.autoStartMusicArmed = true;

    let fired = false;

    const onUnlocked = (): void => {
      if (fired) return;
      fired = true;

      this.bus.off("audio:unlocked", onUnlocked as unknown as (payload: unknown) => void);

      // Set track then play
      this.bus.emit("audio:set-track", { trackId });
      this.bus.emit("audio:play-request", {});
    };

    // If already unlocked for some reason, start immediately.
    const state = this.audioSystem.getState();
    if (state.isUnlocked) {
      this.bus.emit("audio:set-track", { trackId });
      this.bus.emit("audio:play-request", {});
      return;
    }

    // Otherwise wait for unlock completion.
    this.bus.on("audio:unlocked", onUnlocked as unknown as (payload: unknown) => void);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.handleResize);

    // ✅ Unbind bus listeners created by Engine
    this.bus.off("scene:switch", this.onSceneSwitch);

    if (this.devTools) {
      this.devTools.dispose();
      this.devTools = null;
    }

    if (this.debugOverlay) {
      this.debugOverlay.dispose();
      this.debugOverlay = null;
    }

    this.cameraDirector.dispose();

    this.interactionSystem.dispose();
    this.howlerAudioSystem.dispose();

    this.harmonyAmbients?.dispose();
    this.harmonyAmbients = null;

    this.harmony?.dispose();
    this.harmony = null;

    this.harmonyPresets?.dispose();
    this.harmonyPresets = null;

    this.harmonyEnvironment?.dispose();
    this.harmonyEnvironment = null;

    this.particleFX.dispose();

    // Audio: detach bus handlers
    this.audioSystem.dispose();

    this.mediaResolver.dispose();

    // Persistence: cancel any pending autosave timers
    this.gateSystem.dispose();
    this.persistence.dispose();

    this.controlSystem.dispose();
    this.postFX.dispose();
    this.renderer.dispose();
  }
}