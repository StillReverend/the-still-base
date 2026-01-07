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
// ============================================================

import * as THREE from "three";

import type { SceneController, SceneContext, SceneName } from "../apps/SceneTypes";

import type { CorePhase } from "../systems/CoreSystem";
import { CoreSystem } from "../systems/CoreSystem";

// P05 (math-only) Regions
import { RegionSystem } from "../systems/RegionSystem";

export class DemoScene implements SceneController {
  public readonly name: SceneName = "DemoScene";
  public readonly scene = new THREE.Scene();

  private ctx: SceneContext | null = null;

  private core: CoreSystem | null = null;

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

    this.buildLights();
    this.buildCoreAndClock(ctx);
    this.configureCamera(ctx);

    // DEV-only region wireframe overlay
    if (import.meta.env.DEV) {
      this.buildRegionWireframeOverlay();
      ctx.bus.on("debug:toggle-regions", this.onToggleRegions);
    }
  }

  // ----------------------------------------------------------
  // Scene construction
  // ----------------------------------------------------------

  private buildLights(): void {
    this.ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xfff2d1, 1.0);
    this.keyLight.position.set(6, 8, 5);
    this.keyLight.castShadow = false;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x6fa9ff, 0.7);
    this.rimLight.position.set(-5, -3, -7);
    this.rimLight.castShadow = false;
    this.scene.add(this.rimLight);
  }

  private buildCoreAndClock(ctx: SceneContext): void {
    this.core = new CoreSystem({
      bus: ctx.bus,
      config: ctx.config,
      save: ctx.save,
      postFX: ctx.postFX, // ✅ Core drives bloom profiles via phase
    });

    // Start in desired phase (change as needed)
    const phase: CorePhase = "black_hole";
    this.core.setPhase(phase);

    // At P03, shrinkLevel = 0 (largest core)
    this.core.setShrinkLevel(0);

    this.scene.add(this.core.getRoot());
  }

  private configureCamera(ctx: SceneContext): void {
    const camera = ctx.camera;

    const distance = 12;
    const theta = THREE.MathUtils.degToRad(35);
    const phi = THREE.MathUtils.degToRad(45);

    const x = Math.cos(theta) * Math.cos(phi) * distance;
    const y = Math.sin(theta) * distance;
    const z = Math.cos(theta) * Math.sin(phi) * distance;

    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
  }

  // ----------------------------------------------------------
  // DEV: Region wireframe overlay
  // ----------------------------------------------------------

  private buildRegionWireframeOverlay(): void {
    this.regionSystem = new RegionSystem();

    const root = new THREE.Object3D();
    root.name = "RegionWireframeOverlay";

    const y = 0.02;

    const universeRadius = new Date().getFullYear();
    const systemRadius = 1979;
    const spokeRadius = systemRadius;

    const regions = this.regionSystem.getRegions();
    const count = regions.length;
    const wedgeSize = (Math.PI * 2) / count;

    for (let i = 0; i < count; i++) {
      const angle = i * wedgeSize;
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

    this.scene.add(root);
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
      this.scene.remove(this.regionDebugRoot);
      this.regionDebugRoot = null;
    }
    for (const d of this.regionDebugDisposables) d.dispose();
    this.regionDebugDisposables = [];
    this.regionSystem = null;

    if (this.core) {
      this.scene.remove(this.core.getRoot());
      this.core.dispose();
      this.core = null;
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

    this.ctx = null;
  }
}
