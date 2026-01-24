// src/scenes/DemoScene.ts

// ============================================================
// THE STILL — P03
// DemoScene.ts
// ------------------------------------------------------------
// Temporary "main world" scene for P03.
// Responsibilities:
//  - Host the CoreSystem (black hole / sol / luna via CoreStates)
//  - CoreSystem owns clock rings; DemoScene modulates distance factor
//  - Provide a simple lighting setup
//  - Position the camera in a good starting orbit
//  - DEV: Region wireframe overlay
//
// Notes:
//  - Engine owns PostFXSystem (single pipeline). Scenes do NOT construct PostFX.
//  - IMPORTANT: CameraSystem is the authority that writes camera transforms.
//    Therefore, we must use EventBus to request a spawn orbit.
// ============================================================

import * as THREE from "three";

import type { SceneController, SceneContext, SceneName } from "../apps/SceneTypes";

import type { CorePhase } from "../systems/CoreSystem";
import { CoreSystem } from "../systems/CoreSystem";
import { StarSystem } from "../systems/StarSystem";

// P05 (math-only) Regions
import { RegionSystem } from "../systems/RegionSystem";

export class DemoScene implements SceneController {
  public readonly name: SceneName = "DemoScene";
  public readonly scene = new THREE.Scene();

  private ctx: SceneContext | null = null;

  // ----------------------------------------------------------
  // Canonical ClockFace anchor (visual + mathematical truth)
  // ----------------------------------------------------------
  private clockFace: THREE.Object3D | null = null;

  private core: CoreSystem | null = null;
  private starSystem: StarSystem | null = null;

  private ambientLight: THREE.AmbientLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;

  private elapsed = 0;

  // ----------------------------------------------------------
  // DEV: Region wireframe overlay
  // ----------------------------------------------------------
  private regionSystem: RegionSystem | null = null;
  private regionDebugRoot: THREE.Object3D | null = null;
  private regionDebugDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  private onToggleRegions = (): void => {
    if (!this.regionDebugRoot) return;

    this.regionDebugRoot.visible = !this.regionDebugRoot.visible;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[DemoScene] Region overlay ${this.regionDebugRoot.visible ? "ON" : "OFF"}`,
      );
    }
  };

  // ----------------------------------------------------------
  // DEV: DevTools bus hotkeys (core phase)
  // ----------------------------------------------------------

  private onDevCoreCycle = (): void => {
    if (!this.core) return;

    if (this.core.isBlackHoleOverrideEnabled()) {
      this.core.clearBlackHoleOverride();
      return;
    }

    this.core.toggleBlackHoleOverride();
  };

  private onDevCoreClear = (): void => {
    if (!this.core) return;
    this.core.clearBlackHoleOverride();
  };

  // ----------------------------------------------------------
  // init()
  // ----------------------------------------------------------
  public init(ctx: SceneContext): void {
    this.ctx = ctx;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[DemoScene] init");
    }

    // Space-like background
    this.scene.background = new THREE.Color(0x020208);

    // Create the canonical truth anchor FIRST.
    // Everything that cares about "clock center/orientation" should hang off this.
    this.buildClockFace();

    this.buildLights();
    this.buildCoreAndClock(ctx);

    // ✅ TEMP: simple stars so the world isn't empty
    this.buildStars();

    // IMPORTANT: Request canonical spawn orbit from CameraSystem (authoritative).
    this.configureCamera(ctx);

    // DEV-only region wireframe overlay + dev hotkeys
    if (import.meta.env.DEV) {
      this.buildRegionWireframeOverlay();

      // DevTools-driven region overlay toggle
      ctx.bus.on("dev:regions:toggle", this.onToggleRegions);

      // DevTools-driven core controls
      ctx.bus.on("dev:core:cycle", this.onDevCoreCycle);
      ctx.bus.on("dev:core:clear", this.onDevCoreClear);
    }
  }

  // ----------------------------------------------------------
  // Scene construction
  // ----------------------------------------------------------

  private buildClockFace(): void {
    const root = new THREE.Object3D();
    root.name = "ClockFace";

    // Truth decision:
    // - Y-up world
    // - Clock face lives on XZ plane
    // - Rotation axis is Y
    // - Origin is the visual + mathematical center
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);

    this.scene.add(root);
    this.clockFace = root;
  }

  private buildLights(): void {
    this.ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    //this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xfff2d1, 1.0);
    this.keyLight.position.set(6, 8, 5);
    this.keyLight.castShadow = false;
    //this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x6fa9ff, 0.7);
    this.rimLight.position.set(-5, -3, -7);
    this.rimLight.castShadow = false;
    //this.scene.add(this.rimLight);
  }

  private buildCoreAndClock(ctx: SceneContext): void {
    this.core = new CoreSystem({
      bus: ctx.bus,
      config: ctx.config,
      save: ctx.save,
      postFX: ctx.postFX, // ✅ Core drives bloom profiles via phase
    });

    // Start in desired phase (change as needed)
    const phase: CorePhase = "lunar";
    this.core.setPhase(phase);

    // At P03, shrinkLevel = 0 (largest core)
    this.core.setShrinkLevel(0);

    // Core must be parented under ClockFace so it can never drift from our truth anchor.
    if (!this.clockFace) {
      // Should never happen because buildClockFace() runs first.
      this.scene.add(this.core.getRoot());
      return;
    }

    this.clockFace.add(this.core.getRoot());
  }

  // ✅ TEMP: Placeholder stars (will be rewritten later)
  private buildStars(): void {
    this.starSystem = new StarSystem(this.scene, {
      count: 1031,
      radius: 2026,
      size: 0.31,
    });
  }

  /**
   * Canonical spawn view:
   * - Top-down "clock face" view
   * - Screen up = +Z so 12 o'clock is at top, 3 at right, etc.
   *
   * IMPORTANT:
   * CameraSystem writes camera transforms every frame.
   * So we request the orbit through the EventBus ("camera:set-orbit").
   */
  private configureCamera(ctx: SceneContext): void {
    // Tune these as you like:
    const distance = 490; // matches your current debug vibe (~490)
    const theta = 0.0; // azimuth (irrelevant when phi ~ 0, but keep stable)
    const phi = 0.0001; // near-top-down; avoid exact 0 singularity

    // Crucial: make +Z map to "screen up" for a clock-face view.
    // With camera above looking down, this defines orientation on the screen.
    const up = { x: 0, y: 0, z: 1 };

    // Target the ClockFace origin (future-proof if we ever offset the whole face).
    const target = new THREE.Vector3(0, 0, 0);
    if (this.clockFace) {
      this.clockFace.getWorldPosition(target);
    }

    ctx.bus.emit("camera:set-orbit", {
      target: { x: target.x, y: target.y, z: target.z },
      distance,
      theta,
      phi,
      up,
    });
  }

  // ----------------------------------------------------------
  // DEV: Region wireframe overlay
  // ----------------------------------------------------------

  private buildRegionWireframeOverlay(): void {
    this.regionSystem = new RegionSystem();

    // Bind RegionSystem to the canonical clock anchor so its math uses ClockFace-local XZ.
    if (this.clockFace) {
      this.regionSystem.setClockFace(this.clockFace);
    }

    const root = new THREE.Object3D();
    root.name = "RegionWireframeOverlay";
    root.visible = false;

    const y = 0.02;

    const universeRadius = new Date().getFullYear();
    const systemRadius = 1979;
    const spokeRadius = systemRadius;

    const regions = this.regionSystem.getRegions();
    const count = regions.length;
    const wedgeSize = (Math.PI * 2) / count;

    // IMPORTANT:
    // RegionSystem applies baseRotationRad to angles BEFORE wedge selection.
    // A wedge boundary occurs where:
    //   adjustedAngle = i * wedgeSize
    //   atan2(z, x) + baseRotationRad = i*wedgeSize
    //   atan2(z, x) = i*wedgeSize - baseRotationRad
    //
    // So to draw the true boundaries, we subtract baseRotationRad here.
    const baseRotationRad = this.regionSystem.getConfig().baseRotationRad;

    for (let i = 0; i < count; i++) {
      const angle = i * wedgeSize - baseRotationRad;

      const x = Math.cos(angle) * spokeRadius;
      const z = Math.sin(angle) * spokeRadius;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([0, y, 0, x, y, z], 3),
      );

      const hueDeg = regions[i].colorBias.hue;
      const c = new THREE.Color();
      c.setHSL(((hueDeg % 360) + 360) % 360 / 360, 0.9, 0.6);

      const mat = new THREE.LineBasicMaterial({
        color: c,
        transparent: true,
        opacity: 0.75,
        depthTest: true,
        depthWrite: false,
      });

      const line = new THREE.Line(geom, mat);
      line.name = `RegionBoundary_${regions[i].id}`;

      root.add(line);
      this.regionDebugDisposables.push(geom, mat);
    }

    const addRing = (radius: number, name: string, opacity: number): void => {
      const ringSegments = 192;
      const ringPts: number[] = [];

      for (let s = 0; s <= ringSegments; s++) {
        const t = s / ringSegments;
        const a = t * Math.PI * 2;
        ringPts.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      }

      const ringGeom = new THREE.BufferGeometry();
      ringGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(ringPts, 3),
      );

      const ringMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        transparent: true,
        opacity,
        depthTest: true,
        depthWrite: false,
      });

      const ring = new THREE.Line(ringGeom, ringMat);
      ring.name = name;

      root.add(ring);
      this.regionDebugDisposables.push(ringGeom, ringMat);
    };

    addRing(50, "DevRing_50", 0.14);
    addRing(100, "DevRing_100", 0.14);
    addRing(250, "DevRing_250", 0.14);
    addRing(500, "DevRing_500", 0.14);

    addRing(systemRadius, `SystemRadius_${systemRadius}`, 0.25);
    addRing(universeRadius, `UniverseRadius_${universeRadius}`, 0.18);

    // Parent the overlay under ClockFace so it can never drift from the clock truth.
    if (this.clockFace) {
      this.clockFace.add(root);
    } else {
      this.scene.add(root);
    }

    this.regionDebugRoot = root;

    // eslint-disable-next-line no-console
    console.log(
      `[DemoScene] Region overlay enabled. SystemRadius=${systemRadius}, UniverseRadius=${universeRadius}`,
    );
  }

  // ----------------------------------------------------------
  // update()
  // ----------------------------------------------------------
  public update(delta: number): void {
    this.elapsed += delta;

    const camera = this.ctx?.camera ?? null;

    if (this.core && camera) {
      const distance = camera.position.length();

      const minDist = 6;
      const maxDist = 40;

      const t = THREE.MathUtils.clamp(
        (distance - minDist) / (maxDist - minDist),
        0,
        1,
      );

      const distanceFactor = THREE.MathUtils.lerp(1.2, 0.35, t);
      this.core.setClockDistanceFactor(distanceFactor);
    }

    if (this.core) {
      this.core.update(delta);
    }

    if (this.starSystem) {
      this.starSystem.update(delta);
    }
  }

  // ----------------------------------------------------------
  // dispose()
  // ----------------------------------------------------------
  public dispose(): void {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[DemoScene] dispose");
    }

    if (this.regionDebugRoot) {
      if (this.clockFace) {
        this.clockFace.remove(this.regionDebugRoot);
      } else {
        this.scene.remove(this.regionDebugRoot);
      }
      this.regionDebugRoot = null;
    }
    for (const d of this.regionDebugDisposables) d.dispose();
    this.regionDebugDisposables = [];
    this.regionSystem = null;

    if (this.starSystem) {
      this.starSystem.dispose(this.scene);
      this.starSystem = null;
    }

    if (this.core) {
      if (this.clockFace) {
        this.clockFace.remove(this.core.getRoot());
      } else {
        this.scene.remove(this.core.getRoot());
      }
      this.core.dispose();
      this.core = null;
    }

    if (this.clockFace) {
      this.scene.remove(this.clockFace);
      this.clockFace = null;
    }

    if (this.ambientLight) {
      this.scene.remove(this.ambientLight);
      this.ambientLight.dispose();
      this.ambientLight = null;
    }

    if (this.keyLight) {
      this.scene.remove(this.keyLight);
      this.keyLight.dispose();
      this.keyLight = null;
    }

    if (this.rimLight) {
      this.scene.remove(this.rimLight);
      this.rimLight.dispose();
      this.rimLight = null;
    }

    // DEV listener cleanup
    if (this.ctx && import.meta.env.DEV) {
      this.ctx.bus.off("dev:regions:toggle", this.onToggleRegions);
      this.ctx.bus.off("dev:core:cycle", this.onDevCoreCycle);
      this.ctx.bus.off("dev:core:clear", this.onDevCoreClear);
    }

    this.ctx = null;
  }
}
