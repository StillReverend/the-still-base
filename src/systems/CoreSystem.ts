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
//  - Black hole / sun / lunar visual differences will be layered
//    in later phases; here we just provide phase + shrink hooks.
// ============================================================

import * as THREE from "three";

import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";
import type { SaveManager } from "../core/SaveManager";

import { ClockSystem } from "./ClockSystem";
import { TimeSystem } from "./TimeSystem";
import { PresenceSystem } from "./PresenceSystem";

export type CorePhase = "black_hole" | "solar" | "lunar";

export interface CoreSystemDeps {
  bus: EventBus;
  config: Config;
  save: SaveManager;
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

  private phase: CorePhase = "black_hole";
  /** 0..1 where 0 = largest (start of guided) and 1 = fully shrunk. */
  private shrinkLevel = 0;

  constructor(deps: CoreSystemDeps) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.save = deps.save;

    this.root = new THREE.Group();
    this.root.name = "CoreSystemRoot";

    this.coreGroup = new THREE.Group();
    this.coreGroup.name = "CoreBodyGroup";
    this.root.add(this.coreGroup);

    this.buildCoreBody();

    this.clock = new ClockSystem();
    this.time = new TimeSystem();

    // Presence is a world-state driver (P04)
    this.presence = new PresenceSystem();
    this.presence.enableDebugHotkeys();
    // If you want console control too, uncomment:
    // this.presence.devExposeToWindow();

    this.root.add(this.clock.getRoot());
    this.root.add(this.time.getRoot());

    // Basic starting rotation so the core is not perfectly aligned
    this.root.rotation.x = 0.15;
    this.root.rotation.y = -0.2;
  }

  // ----------------------------------------------------------
  // Internal builders
  // ----------------------------------------------------------

  private buildCoreBody(): void {
    // Base radius for the black hole body in P03
    const radius = 7.9;

    // Core sphere (black hole placeholder, dark with subtle spec)
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

    // Simple aura: slightly larger, translucent shell
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

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public update(dt: number): void {
    // Subtle slow rotation so core is always gently alive
    // const spin = dt * 0.06;
    // this.root.rotation.y += spin;

    // Presence should drive clock *before* clock renders this frame.
    this.presence.update(dt);
    this.clock.setRingPresenceLevels(this.presence.getClockPresenceLevels());

    this.clock.update(dt);
    this.time.update(dt);
  }

  public dispose(): void {
    // Unhook debug listeners if this system gets torn down
    this.presence.disableDebugHotkeys();

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
  }

  /**
   * 0..1 where:
   *  - 0 = largest, scariest black hole (start of guided experience)
   *  - 1 = fully shrunk (ready to transition to solar form)
   *
   * For P03 this just scales the core group; later we can also
   * change materials, audio, and particle behavior.
   */
  public setShrinkLevel(level: number): void {
    this.shrinkLevel = THREE.MathUtils.clamp(level, 0, 1);

    // Map to a reasonable scale range, e.g. 1.0 → 0.3
    const maxScale = 1.0;
    const minScale = 0.3;
    const scale = maxScale - (maxScale - minScale) * this.shrinkLevel;

    this.coreGroup.scale.setScalar(scale);
    this.clock.getRoot().scale.setScalar(scale);
    this.time.getRoot().scale.setScalar(scale);
  }

  /**
   * Switch between black_hole / solar / lunar phases.
   * In P03 we just remember the phase; later we will swap
   * materials, colors, audio, etc.
   */
  public setPhase(phase: CorePhase): void {
    this.phase = phase;

    // Stub: in future, adjust materials by phase.
    // e.g. black hole: dark core, blue aura
    //      solar: bright emissive gold, warm aura
    //      lunar: desaturated, cooler colors
  }
}
