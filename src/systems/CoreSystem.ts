// src/systems/CoreSystem.ts

// ============================================================
// THE STILL — P03
// CoreSystem.ts
// ------------------------------------------------------------
// Responsibilities:
//  - Own the central core object of THE STILL
//    * Core sphere (black hole placeholder in P03)
//    * Simple aura shell
//    * ClockSystem (H/M/S neon starlight rings)
//    * TimeSystem (stubbed for future audio-reactive rings)
//  - Manage basic core transforms (scale/rotation)
//  - Provide a minimal API for higher-level systems.
//
// Notes:
//  - This does NOT know about constellations, stars, or audio yet.
//  - Black hole / sun / lunar visual differences are handled via CoreStates.
//
// Behavior (P03 update):
//  - Default phase is driven by local time-of-day (solar/lunar).
//  - Phase override API is provided for higher-level systems (DebugTools, etc).
//    * No hotkeys are owned by CoreSystem.
// ============================================================

import * as THREE from "three";

import type { EventBus, EventHandler } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

import { ClockSystem } from "./ClockSystem";
import { TimeSystem } from "./TimeSystem";

import type { CoreStateName } from "./CoreStates";
import { CoreStates } from "./CoreStates";

import type { PostFXSystem, PostFXProfileName } from "./PostFXSystem";

export type CorePhase = "black_hole" | "solar" | "lunar";

export interface CoreSystemDeps {
  bus: EventBus;
  config: Config;
  save: SaveManager;

  /**
   * Optional: Engine-owned PostFX pipeline.
   * Keep optional so CoreSystem can run without PostFX.
   */
  postFX?: PostFXSystem;
}

type GateOpenedPayload = {
  reason?: "ritual" | "manual";
  atMs?: number;
};

type ForceBlackHolePayload = {
  reason?: "midnight" | "boot-enforce" | "manual";
  atMs?: number;
};

type AudioFramePayload = {
  frame?: {
    energy?: number;
    low?: number;
    mid?: number;
    high?: number;
  };
};

export class CoreSystem {
  private readonly root: THREE.Group;

  private readonly bus: EventBus;
  private readonly config: Config;
  private readonly save: SaveManager;

  private readonly coreGroup: THREE.Group;
  private coreSphere: THREE.Mesh | null = null;
  private auraSphere: THREE.Mesh | null = null;

  private readonly clock: ClockSystem;
  private readonly time: TimeSystem;

  private coreStates: CoreStates | null = null;

  private postFX: PostFXSystem | null = null;

  // Phase state
  private phase: CorePhase = "solar"; // default; will be corrected on first applyDesiredPhase()
  private shrinkLevel = 0;

  // Time-of-day settings (local time)
  private readonly solarStartHour = 6; // 6 AM inclusive
  private readonly lunarStartHour = 18; // 6 PM inclusive

  // Override behavior
  private blackHoleOverride = false;
  private appliedPhase: CorePhase | null = null;

  private disposed = false;

  // --------------------------------------------------------
  // Audio-reactive core (Phase 1, additive)
  // --------------------------------------------------------
  // AudioSystem emits "audio:frame" with normalized bands; we cache the latest
  // and feed it into CoreStates.update() each frame.
  private lastAudioFrame = { energy: 0, low: 0, mid: 0, high: 0 };

  // --------------------------------------------------------
  // EventBus handler refs (for proper cleanup)
  // --------------------------------------------------------
  private readonly onAudioFrame: EventHandler<AudioFramePayload>;
  private readonly onForceBlackHole: EventHandler<ForceBlackHolePayload>;
  private readonly onGateOpened: EventHandler<GateOpenedPayload>;

  constructor(deps: CoreSystemDeps) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.save = deps.save;

    this.postFX = deps.postFX ?? null;

    this.root = new THREE.Group();
    this.root.name = "CoreSystemRoot";

    this.coreGroup = new THREE.Group();
    this.coreGroup.name = "CoreBodyGroup";
    this.root.add(this.coreGroup);

    this.buildCoreBody();

    // Core visual states
    this.coreStates = new CoreStates({
      parent: this.coreGroup,
      radius: 79,
      initialState: this.mapPhaseToState(this.phase),
    });

    // Hide placeholder meshes when CoreStates is active
    if (this.coreSphere) this.coreSphere.visible = false;
    if (this.auraSphere) this.auraSphere.visible = false;

    // Clock & Time systems
    this.clock = new ClockSystem();
    this.time = new TimeSystem();

    this.root.add(this.clock.getRoot());
    this.root.add(this.time.getRoot());

    this.root.rotation.set(0, 0, 0);

    // --------------------------------------------------------
    // Define handlers (stored for bus.off in dispose)
    // --------------------------------------------------------

    // Cache latest frame for CoreStates.update()
    this.onAudioFrame = (payload) => {
      const f = payload?.frame;
      if (!f) return;

      this.lastAudioFrame = {
        energy: clamp01(f.energy ?? this.lastAudioFrame.energy),
        low: clamp01(f.low ?? this.lastAudioFrame.low),
        mid: clamp01(f.mid ?? this.lastAudioFrame.mid),
        high: clamp01(f.high ?? this.lastAudioFrame.high),
      };
    };

    // GateSystem requests a forced black hole on close.
    this.onForceBlackHole = (payload) => {
      // Idempotent: if already forced, just re-apply.
      this.blackHoleOverride = true;
      this.applyDesiredPhase(true);

      // Optional visibility for debugging
      try {
        this.bus.emit("core:phase", {
          phase: "black_hole",
          override: true,
          source: "gate",
          payload,
        });
      } catch {
        // no-op
      }
    };

    // When the gate re-opens, release the forced black hole and return to time-of-day phase.
    this.onGateOpened = () => {
      if (!this.blackHoleOverride) return;
      this.blackHoleOverride = false;
      this.applyDesiredPhase(true);
    };

    // --------------------------------------------------------
    // Register handlers
    // --------------------------------------------------------
    this.bus.on<AudioFramePayload>("audio:frame", this.onAudioFrame);
    this.bus.on<ForceBlackHolePayload>("core:force-black-hole", this.onForceBlackHole);
    this.bus.on<GateOpenedPayload>("gate:opened", this.onGateOpened);

    // Apply initial desired phase (solar/lunar by time-of-day unless overridden)
    this.applyDesiredPhase(true);
  }

  // ----------------------------------------------------------
  // Internal builders
  // ----------------------------------------------------------

  private buildCoreBody(): void {
    const radius = 3.1;

    const coreGeom = new THREE.SphereGeometry(radius, 64, 64);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a40,
      metalness: 0.8,
      roughness: 0.4,
      emissive: 0x000000,
    });

    this.coreSphere = new THREE.Mesh(coreGeom, coreMat);
    this.coreSphere.name = "CoreSphere";
    this.coreGroup.add(this.coreSphere);

    const auraGeom = new THREE.SphereGeometry(radius * 1.15, 48, 48);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0x222244,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.auraSphere = new THREE.Mesh(auraGeom, auraMat);
    this.auraSphere.name = "CoreAura";
    this.coreGroup.add(this.auraSphere);
  }

  private mapPhaseToState(phase: CorePhase): CoreStateName {
    switch (phase) {
      case "solar":
        return "sol";
      case "lunar":
        return "luna";
      case "black_hole":
      default:
        return "blackHole";
    }
  }

  private mapPhaseToPostFXProfile(phase: CorePhase): PostFXProfileName {
    switch (phase) {
      case "solar":
        return "solar";
      case "lunar":
        return "luna";
      case "black_hole":
      default:
        return "blackHole";
    }
  }

  private applyPostFXProfileFromPhase(phase: CorePhase): void {
    if (!this.postFX) return;
    this.postFX.setProfile(this.mapPhaseToPostFXProfile(phase));
  }

  // ----------------------------------------------------------
  // Time-of-day + override phase logic
  // ----------------------------------------------------------

  private computeTimeOfDayPhase(): CorePhase {
    const now = new Date();
    const h = now.getHours();

    // solar between solarStartHour (inclusive) and lunarStartHour (exclusive)
    if (h >= this.solarStartHour && h < this.lunarStartHour) return "solar";
    return "lunar";
  }

  private getDesiredPhase(): CorePhase {
    if (this.blackHoleOverride) return "black_hole";
    return this.computeTimeOfDayPhase();
  }

  private applyDesiredPhase(force: boolean = false): void {
    const desired = this.getDesiredPhase();
    if (!force && this.appliedPhase === desired) return;

    this.appliedPhase = desired;
    this.phase = desired;

    if (this.coreStates) {
      this.coreStates.setState(this.mapPhaseToState(desired));
    }

    this.applyPostFXProfileFromPhase(desired);

    // Optional: let other systems observe phase changes
    try {
      this.bus.emit("core:phase", { phase: desired, override: this.blackHoleOverride });
    } catch {
      // no-op
    }
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public update(dt: number): void {
    // Keep phase aligned to time-of-day (unless black hole override is active)
    this.applyDesiredPhase(false);

    if (this.coreStates) {
      // Feed real audio energy into CoreStates (Phase 1)
      this.coreStates.update(dt, this.lastAudioFrame);
    }

    //this.clock.update(dt);
    this.time.update(dt);
  }

  public setClockDistanceFactor(distanceFactor: number): void {
    this.clock.setDistanceFactor(distanceFactor);
  }

  public setPostFX(postFX: PostFXSystem | null): void {
    this.postFX = postFX;
    this.applyPostFXProfileFromPhase(this.phase);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Unhook EventBus listeners (prevents duplicate reactions on scene reload / hot reload)
    this.bus.off<AudioFramePayload>("audio:frame", this.onAudioFrame);
    this.bus.off<ForceBlackHolePayload>("core:force-black-hole", this.onForceBlackHole);
    this.bus.off<GateOpenedPayload>("gate:opened", this.onGateOpened);

    if (this.coreStates) {
      this.coreStates.dispose();
      this.coreStates = null;
    }

    if (this.coreSphere) {
      this.coreGroup.remove(this.coreSphere);
      this.coreSphere.geometry.dispose();
      (this.coreSphere.material as THREE.Material).dispose();
      this.coreSphere = null;
    }

    if (this.auraSphere) {
      this.coreGroup.remove(this.auraSphere);
      this.auraSphere.geometry.dispose();
      (this.auraSphere.material as THREE.Material).dispose();
      this.auraSphere = null;
    }

    this.clock.dispose();
    this.time.dispose();

    this.postFX = null;
  }

  public setShrinkLevel(level: number): void {
    this.shrinkLevel = THREE.MathUtils.clamp(level, 0, 1);

    const maxScale = 1.0;
    const minScale = 0.3;
    const scale = maxScale - (maxScale - minScale) * this.shrinkLevel;

    this.coreGroup.scale.setScalar(scale);
    this.clock.getRoot().scale.setScalar(scale);
    this.time.getRoot().scale.setScalar(scale);
  }

  /**
   * Manual phase setter.
   * NOTE:
   * - This sets the phase immediately.
   * - If black hole override is OFF, the next update() will snap back to time-of-day.
   * - If you want manual lock behavior, we can add a "manualLock" mode later.
   */
  public setPhase(phase: CorePhase): void {
    this.phase = phase;
    this.appliedPhase = phase;

    if (this.coreStates) {
      this.coreStates.setState(this.mapPhaseToState(phase));
    }

    this.applyPostFXProfileFromPhase(phase);
  }

  /**
   * Toggle black hole override on/off.
   * When enabled, phase is forced to black_hole until cleared.
   */
  public toggleBlackHoleOverride(): void {
    this.blackHoleOverride = !this.blackHoleOverride;
    this.applyDesiredPhase(true);
  }

  /**
   * Explicitly clear black hole override (returns to time-of-day).
   */
  public clearBlackHoleOverride(): void {
    this.blackHoleOverride = false;
    this.applyDesiredPhase(true);
  }

  public isBlackHoleOverrideEnabled(): boolean {
    return this.blackHoleOverride;
  }
}

const clamp01 = (v: number): number => {
  const n = Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
};
