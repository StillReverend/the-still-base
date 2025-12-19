// ============================================================
// THE STILL — P03
// DemoScene.ts
// ------------------------------------------------------------
// Temporary "main world" scene for P03.
// Responsibilities:
//  - Host the CoreSystem (black hole)
//  - Host the ClockSystem (H/M/S neon rings) parented to core
//  - Provide a simple lighting setup
//  - Position the camera in a good starting orbit
//  - Drive distance-based brightness for the clock rings
//
// Notes:
//  - BootScene will eventually handle arrival/cinematics.
//  - This scene will likely evolve/rename into the main
//    STILL scene later (e.g. StillScene).
// ============================================================

import * as THREE from "three";

import type {
  SceneController,
  SceneContext,
  SceneName,
} from "../apps/SceneTypes";

import type { CorePhase } from "../systems/CoreSystem";
import { CoreSystem } from "../systems/CoreSystem";
import { ClockSystem } from "../systems/ClockSystem";

// P05 (math-only) Regions
import { RegionSystem } from "../systems/RegionSystem";

export class DemoScene implements SceneController {
  public readonly name: SceneName = "DemoScene";
  public readonly scene = new THREE.Scene();

  private ctx: SceneContext | null = null;

  private core: CoreSystem | null = null;
  private clock: ClockSystem | null = null;

  private ambientLight: THREE.AmbientLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;

  private elapsed = 0;

  // ----------------------------------------------------------
  // DEV: Region wireframe overlay
  // ----------------------------------------------------------
  private regionSystem: RegionSystem | null = null;
  private regionDebugRoot: THREE.Object3D | null = null;
  private regionDebugDisposables: Array<THREE.BufferGeometry | THREE.Material> =
    [];

  // NOTE:
  // We intentionally keep the event handler as a bound class property so
  // removeEvent/off patterns stay simple later (if your EventBus supports off()).
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

      // Wire DebugOverlay hotkey -> Scene toggle
      // DebugOverlay emits: "debug:toggle-regions"
      ctx.bus.on("debug:toggle-regions", this.onToggleRegions);
    }
  }

  // ----------------------------------------------------------
  // Scene construction
  // ----------------------------------------------------------

  private buildLights(): void {
    // Soft ambient light so shadows aren't crushed
    this.ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    this.scene.add(this.ambientLight);

    // Key light, warm-ish
    this.keyLight = new THREE.DirectionalLight(0xfff2d1, 1.0);
    this.keyLight.position.set(6, 8, 5);
    this.keyLight.castShadow = false;
    this.scene.add(this.keyLight);

    // Rim/cool light to give the core some edge
    this.rimLight = new THREE.DirectionalLight(0x6fa9ff, 0.7);
    this.rimLight.position.set(-5, -3, -7);
    this.rimLight.castShadow = false;
    this.scene.add(this.rimLight);
  }

  /**
   * Build the core (black hole) and attach the clock rings
   * as a child so they always travel with the core.
   */
  private buildCoreAndClock(ctx: SceneContext): void {
    // --- Core ---
    this.core = new CoreSystem({
      bus: ctx.bus,
      config: ctx.config,
      save: ctx.save,
    });

    // Start in black hole phase (guided experience default)
    const phase: CorePhase = "black_hole";
    this.core.setPhase(phase);

    // At P03, shrinkLevel = 0 (largest core)
    this.core.setShrinkLevel(0);

    const coreRoot = this.core.getRoot();
    this.scene.add(coreRoot);

    // --- Clock ---
    this.clock = new ClockSystem({
      // using defaults: 12/60/360 points for H/M/S
      // tailLength can be tuned later if needed
    });

    const clockRoot = this.clock.getRoot();
    clockRoot.name = "ClockSystemRoot";

    // Parent the clock under the core so they feel like one unit.
    coreRoot.add(clockRoot);

    // Set initial visual baseline for P03:
    // - Slightly under full intensity so we have headroom later.
    // - Distance factor will modulate further each frame.
    this.clock.setGlobalIntensity(0.9);
  }

  private configureCamera(ctx: SceneContext): void {
    // Reasonable starting position: "NEAR" the core and slightly above
    const camera = ctx.camera;

    const distance = 12; // can tune later to match your AT/NEAR/FAR scheme
    const theta = THREE.MathUtils.degToRad(35); // elevation angle
    const phi = THREE.MathUtils.degToRad(45); // around Y

    const x = Math.cos(theta) * Math.cos(phi) * distance;
    const y = Math.sin(theta) * distance;
    const z = Math.cos(theta) * Math.sin(phi) * distance;

    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
  }

  // ----------------------------------------------------------
  // DEV: Region wireframe overlay (spokes + rings)
  // ----------------------------------------------------------

  private buildRegionWireframeOverlay(): void {
    // Keep this completely optional and self-contained.
    // No impact on gameplay systems.
    this.regionSystem = new RegionSystem();

    const root = new THREE.Object3D();
    root.name = "RegionWireframeOverlay";

    // Slight lift so lines don’t fight with any future ground plane
    const y = 0.02;

    // --- Universe/System scale rules ---
    // UniverseRadius = current calendar year (2025 now, +1 each year)
    // SystemRadius = "edge of content" for now (authored space boundary)
    //
    // Notes:
    // - Keep these DEV-only for now; later we can promote to Config as a source of truth.
    const universeRadius = new Date().getFullYear(); // e.g., 2025
    const systemRadius = 1979;

    // Region spokes should reach to the SystemRadius (content boundary),
    // not the UniverseRadius (which is mostly outer-dark/void).
    const spokeRadius = systemRadius;

    const regions = this.regionSystem.getRegions();
    const count = regions.length;

    // Matches RegionSystem wedge layout: evenly spaced around Y
    const wedgeSize = (Math.PI * 2) / count;

    // Spokes: wedge boundaries at angles 0, wedge, 2*wedge...
    for (let i = 0; i < count; i++) {
      const angle = i * wedgeSize;
      const x = Math.cos(angle) * spokeRadius;
      const z = Math.sin(angle) * spokeRadius;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([0, y, 0, x, y, z], 3),
      );

      // Color-coded by region bias hue (purely for dev legibility)
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

    // Helper: add a ring (Line) at a given radius.
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

    // Comfort rings (small scale references)
    addRing(50, "DevRing_50", 0.14);
    addRing(100, "DevRing_100", 0.14);
    addRing(250, "DevRing_250", 0.14);
    addRing(500, "DevRing_500", 0.14);

    // System boundary ring (content edge)
    addRing(systemRadius, `SystemRadius_${systemRadius}`, 0.25);

    // Universe boundary ring (legal edge of existence this year)
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

    if (this.core) {
      this.core.update(delta);
    }

    const camera = this.ctx?.camera ?? null;

    if (this.clock && camera) {
      // Distance from camera to core (assumed at world origin).
      const distance = camera.position.length();

      // Map distance into a brightness factor.
      // Closer to the core => brighter rings.
      //
      // minDist: inside this, clamp to max brightness
      // maxDist: beyond this, clamp to min brightness
      const minDist = 6;
      const maxDist = 40;

      const t = THREE.MathUtils.clamp(
        (distance - minDist) / (maxDist - minDist),
        0,
        1,
      );

      // When t=0 (very close), factor ~1.2 (bright/hot).
      // When t=1 (far), factor ~0.35 (dim but visible).
      const distanceFactor = THREE.MathUtils.lerp(1.2, 0.35, t);

      this.clock.setDistanceFactor(distanceFactor);
      this.clock.update(delta);
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

    // DEV: remove region overlay + dispose resources
    if (this.regionDebugRoot) {
      this.scene.remove(this.regionDebugRoot);
      this.regionDebugRoot = null;
    }
    for (const d of this.regionDebugDisposables) {
      d.dispose();
    }
    this.regionDebugDisposables = [];
    this.regionSystem = null;

    // NOTE:
    // If your EventBus later supports an .off() API, we should unregister
    // ctx.bus.off("debug:toggle-regions", this.onToggleRegions) here.
    // For now, DemoScene persists in the initialized cache, so the handler
    // remains valid. (No harm, and it keeps toggling working reliably.)

    // Clock first (it’s a child of core)
    if (this.clock) {
      if (this.core) {
        this.core.getRoot().remove(this.clock.getRoot());
      }
      this.clock.dispose();
      this.clock = null;
    }

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
  }
}
