// src/scenes/BootScene.ts

import * as THREE from "three";
import type { SceneController, SceneContext } from "../apps/SceneTypes";
import type { SceneName } from "../apps/SceneTypes";

interface SceneSwitchPayload {
  name: SceneName;
}

export class BootScene implements SceneController {
  public readonly name: SceneName = "BootScene";
  public readonly scene = new THREE.Scene();

  private ctx: SceneContext | null = null;
  private cube: THREE.Mesh | null = null;
  private elapsed = 0;
  private hasRequestedSwitch = false;

  init(ctx: SceneContext): void {
    this.ctx = ctx;

    this.scene.background = new THREE.Color(0x050509);

    const geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2);
    const material = new THREE.MeshStandardMaterial({
      color: 0xd4af37, // gold-ish
      metalness: 0.9,
      roughness: 0.2,
      emissive: new THREE.Color(0x2a1a05),
      emissiveIntensity: 0.4,
    });

    this.cube = new THREE.Mesh(geometry, material);
    this.scene.add(this.cube);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 1.2);
    directional.position.set(3, 5, 2);
    this.scene.add(directional);

    const { camera } = ctx;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[BootScene] init");
    }
  }

  update(delta: number): void {
    if (!this.cube) return;

    this.elapsed += delta;

    const t = this.elapsed;
    this.cube.rotation.x = t * 0.5;
    this.cube.rotation.y = t * 0.8;

    const scale = 1 + Math.sin(t * 2.0) * 0.05;
    this.cube.scale.setScalar(scale);

    // After 3 seconds, request switch to DemoScene (once)
    if (!this.hasRequestedSwitch && this.elapsed > 3.0 && this.ctx) {
      this.hasRequestedSwitch = true;

      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[BootScene] Requesting switch to DemoScene");
      }

      const payload: SceneSwitchPayload = { name: "DemoScene" };
      this.ctx.bus.emit<SceneSwitchPayload>("scene:switch", payload);
    }
  }

  dispose(): void {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[BootScene] dispose");
    }

    if (this.cube) {
      this.scene.remove(this.cube);
      this.cube.geometry.dispose();
      (this.cube.material as THREE.Material).dispose();
      this.cube = null;
    }
  }
}
