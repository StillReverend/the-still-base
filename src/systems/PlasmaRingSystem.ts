// src/systems/PlasmaRingSystem.ts

import * as THREE from "three";
import type { PostFXSystem } from "./PostFXSystem";

export type PlasmaPaletteName = "indigo" | "cream" | "gold";

export type PlasmaRingDeps = {
  parent: THREE.Object3D;
  postFX?: PostFXSystem | null;

  radius: number;        // ring center radius
  tube: number;          // ring thickness
  radialSegments?: number;
  tubularSegments?: number;
};

export class PlasmaRingSystem {
  private readonly root: THREE.Group;

  private readonly ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  private energy = 0; // 0..1
  private palette: PlasmaPaletteName = "indigo";

  constructor(deps: PlasmaRingDeps) {
    this.root = new THREE.Group();
    this.root.name = "PlasmaRingRoot";
    deps.parent.add(this.root);

    const geom = new THREE.TorusGeometry(
      deps.radius,
      deps.tube,
      deps.radialSegments ?? 24,
      deps.tubularSegments ?? 192,
    );

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffed,
      metalness: 0.0,
      roughness: 0.35,

      // We’ll drive this for “glow”
      emissive: new THREE.Color(0x103179),
      emissiveIntensity: 1.0,
    });

    this.ring = new THREE.Mesh(geom, mat);
    this.ring.name = "PlasmaRing";
    this.ring.rotation.x = Math.PI / 2; // face outward around core by default
    this.root.add(this.ring);

    // Selective bloom: only the ring should be in bloom layer
    if (deps.postFX) {
      // If you implement the selective bloom version I shared earlier
      // this helper will exist. Otherwise, replace with: this.ring.layers.enable(1)
      PostFXSystem.enableBloom(this.ring);
    } else {
      // fallback: still enable bloom layer in case camera composer uses it
      this.ring.layers.enable(1);
    }

    this.applyPalette();
    this.applyEnergy();
  }

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public getRingMesh(): THREE.Object3D {
    return this.ring;
  }

  public setPalette(name: PlasmaPaletteName): void {
    this.palette = name;
    this.applyPalette();
  }

  public setEnergy(value01: number): void {
    if (!Number.isFinite(value01)) return;
    this.energy = THREE.MathUtils.clamp(value01, 0, 1);
    this.applyEnergy();
  }

  /**
   * Placeholder for your future “vapor ring wave” burst.
   * Tonight we just stub it so systems can call it without refactoring later.
   */
  public emitWave(_opts?: { intensity?: number }): void {
    // Future:
    // - spawn ring shockwave mesh (billboard torus/sprite)
    // - shader: expanding radius, fading alpha
    // - optional noise to feel “plasma / smoke”
  }

  public update(_dt: number): void {
    // Future:
    // - subtle turbulence animation
    // - audio-reactive expansion
  }

  private applyPalette(): void {
    const c =
      this.palette === "indigo" ? 0x103179 :
      this.palette === "cream" ? 0xffffed :
      0xd4af37; // gold

    this.ring.material.emissive.setHex(c);
  }

  private applyEnergy(): void {
    // “game-grade”: smooth glow response without spikes
    // You can tune this later alongside PostFX bloom.
    const e = this.energy;
    this.ring.material.emissiveIntensity = 0.8 + (e * e) * 2.2;

    // Optional: subtle physical size response (safe, cheap)
    const scale = 1.0 + e * 0.03;
    this.ring.scale.setScalar(scale);
  }

  public dispose(): void {
    this.root.remove(this.ring);
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    // @ts-expect-error
    this.ring = null;
    // @ts-expect-error
    this.root = null;
  }
}
