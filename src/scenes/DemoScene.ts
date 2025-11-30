// src/scenes/DemoScene.ts

import * as THREE from "three";
import type { SceneController, SceneContext, SceneName } from "../apps/SceneTypes";

export class DemoScene implements SceneController {
  public readonly name: SceneName = "DemoScene";
  public readonly scene = new THREE.Scene();

  private ctx: SceneContext | null = null;
  private sphere: THREE.Mesh | null = null;
  private elapsed = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;

    this.scene.background = new THREE.Color(0x020207);

    const geometry = new THREE.SphereGeometry(1.0, 48, 48);
    const material = new THREE.MeshStandardMaterial({
      color: 0x6ec3ff,
      metalness: 0.2,
      roughness: 0.4,
      emissive: new THREE.Color(0x123456),
      emissiveIntensity: 0.7,
    });

    this.sphere = new THREE.Mesh(geometry, material);
    this.scene.add(this.sphere);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(-4, 6, 3);
    this.scene.add(dir);

    if (this.ctx) {
      const { camera } = this.ctx;
      camera.position.set(0, 0, 4.5);
      camera.lookAt(0, 0, 0);
    }
  }

  update(delta: number): void {
    if (!this.sphere) return;

    this.elapsed += delta;
    const t = this.elapsed;

    this.sphere.rotation.y = t * 0.4;
    this.sphere.rotation.x = Math.sin(t * 0.5) * 0.2;

    const material = this.sphere.material as THREE.MeshStandardMaterial;
    const pulse = 0.6 + Math.sin(t * 2.0) * 0.4;
    material.emissiveIntensity = pulse;
  }

  dispose(): void {
    if (this.sphere) {
      this.scene.remove(this.sphere);
      this.sphere.geometry.dispose();
      (this.sphere.material as THREE.Material).dispose();
      this.sphere = null;
    }
  }
}
