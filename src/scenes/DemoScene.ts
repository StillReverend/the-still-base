// ============================================================
// THE STILL — P03
// DemoScene.ts
// ------------------------------------------------------------
// Temporary "main world" scene for P03.
// Responsibilities:
//  - Host the CoreSystem (black hole + clock rings)
//  - Provide a simple lighting setup
//  - Position the camera in a good starting orbit
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
    this.buildCore(ctx);

    this.configureCamera(ctx);
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

  private buildCore(ctx: SceneContext): void {
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

    this.scene.add(this.core.getRoot());
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
  // update()
  // ----------------------------------------------------------
  public update(delta: number): void {
    this.elapsed += delta;

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

    if (this.core) {
      this.core.dispose();
      this.scene.remove(this.core.getRoot());
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
