// ============================================================
// THE STILL — TEMP
// StarSystem.ts
// ------------------------------------------------------------
// Purpose:
//  - Simple placeholder starfield
//  - No interaction, no audio, no vibes
//  - Will be replaced later
// ============================================================

import * as THREE from "three";

export class StarSystem {
  private points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private material: THREE.PointsMaterial;

  constructor(
    scene: THREE.Scene,
    options?: {
      count?: number;
      radius?: number;
      size?: number;
    }
  ) {
    const count = options?.count ?? 79;
    const radius = options?.radius ?? 100;
    const size = options?.size ?? .31;

    this.geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const r = Math.random() * radius;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }

    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3)
    );

    this.material = new THREE.PointsMaterial({
      color: 0xffffed,
      size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    scene.add(this.points);
  }

  // ------------------------------------------------------------
  // Optional update hook (currently unused)
  // ------------------------------------------------------------
  update(_dt: number): void {
    // intentionally empty
  }

  // ------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------
  dispose(scene: THREE.Scene): void {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
