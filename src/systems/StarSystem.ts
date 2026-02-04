// ============================================================
// THE STILL — TEMP
// StarSystem.ts
// ------------------------------------------------------------
// Purpose:
//  - Simple placeholder starfield
//  - No interaction, no audio, no vibes
//  - Will be replaced later
//
// Update:
//  - Adds a persistent occlusion zone around the Core (no stars within)
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
      radius?: number;          // outer radius of star distribution
      exclusionRadius?: number; // inner "no-star" radius around the core
      size?: number;
    }
  ) {
    const count = options?.count ?? 79;
    const radius = options?.radius ?? 100;
    const exclusionRadius = options?.exclusionRadius ?? 0;
    const size = options?.size ?? 1.5;

    if (radius <= 0) {
      throw new Error(`[StarSystem] radius must be > 0. Got ${radius}.`);
    }
    if (exclusionRadius < 0) {
      throw new Error(`[StarSystem] exclusionRadius must be >= 0. Got ${exclusionRadius}.`);
    }
    if (exclusionRadius >= radius) {
      throw new Error(
        `[StarSystem] exclusionRadius (${exclusionRadius}) must be < radius (${radius}).`
      );
    }

    this.geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);

    // Uniform distribution in a spherical shell:
    // - Direction: uniform on sphere
    // - Radius: sample r^3 uniformly between [r0^3, R^3]
    const r0 = exclusionRadius;
    const r0c = r0 * r0 * r0;
    const Rc = radius * radius * radius;

    for (let i = 0; i < count; i++) {
      // direction
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1; // cos(phi) in [-1, 1]
      const phi = Math.acos(u);

      // radius in shell (volume-uniform)
      const t = Math.random();
      const r = Math.cbrt(r0c + t * (Rc - r0c));

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    this.material = new THREE.PointsMaterial({
      color: 0xffdd70,
      size,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "StarFieldPoints";
    scene.add(this.points);
  }

  update(_dt: number): void {
    // intentionally empty
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
