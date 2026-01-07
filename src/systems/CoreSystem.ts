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
// ============================================================

import * as THREE from "three";

import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

import { ClockSystem } from "./ClockSystem";
import { TimeSystem } from "./TimeSystem";
import { PresenceSystem } from "./PresenceSystem";

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
  private readonly presence: PresenceSystem;

  private coreStates: CoreStates | null = null;

  private postFX: PostFXSystem | null = null;

  private phase: CorePhase = "black_hole";
  private shrinkLevel = 0;

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

    this.coreStates = new CoreStates({
      parent: this.coreGroup,
      radius: 7.9,
      initialState: this.mapPhaseToState(this.phase),
    });

    if (this.coreSphere) this.coreSphere.visible = false;
    if (this.auraSphere) this.auraSphere.visible = false;

    this.clock = new ClockSystem();
    this.time = new TimeSystem();

    this.presence = new PresenceSystem();
    this.presence.enableDebugHotkeys();

    this.root.add(this.clock.getRoot());
    this.root.add(this.time.getRoot());

    this.root.rotation.set(0, 0, 0);

    // Keep PostFX aligned with starting phase (if wired)
    this.applyPostFXProfileFromPhase(this.phase);
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
  // Public API
  // ----------------------------------------------------------

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public update(dt: number): void {
    this.presence.update(dt);
    this.clock.setRingPresenceLevels(this.presence.getClockPresenceLevels());

    if (this.coreStates) {
      this.coreStates.update(dt, { energy: 0 });
    }

    this.clock.update(dt);
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
    this.presence.disableDebugHotkeys();

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
   * Switch between black_hole / solar / lunar phases.
   * CoreStates changes visuals, PostFX profile follows phase.
   */
  public setPhase(phase: CorePhase): void {
    this.phase = phase;

    if (this.coreStates) {
      this.coreStates.setState(this.mapPhaseToState(phase));
    }

    this.applyPostFXProfileFromPhase(phase);
  }
}
