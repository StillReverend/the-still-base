// src/systems/fieldfx/emitters/LeavesEmitter.ts
// ============================================================
// THE STILL — LeavesEmitter (BAND morph controller)
//
// Update (visibility / max control):
//  - Introduced LeavesLook profile (size/opacity/color/blending) derived from base
//  - sampleMaterial() now uses LeavesLook so leaves read in DEFAULT filter mode
//  - Switched default blending to AdditiveBlending for luminosity (you can flip to Normal)
//  - Added setLook() to tune without hunting constants
// ============================================================

import * as THREE from "three";

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const isFiniteNumber = (v: number): boolean => Number.isFinite(v) && !Number.isNaN(v);

type MaterialState = {
  size: number;
  opacity: number;
  color: THREE.Color;
  blending: THREE.Blending;
  transparent: boolean;
  depthWrite: boolean;
  sizeAttenuation: boolean;
};

class LcgRng {
  private s: number;
  constructor(seed = 424242) {
    this.s = seed >>> 0;
  }
  next01(): number {
    this.s = (1664525 * this.s + 1013904223) >>> 0;
    return (this.s >>> 0) / 4294967296;
  }
  nextSigned(): number {
    return this.next01() * 2 - 1;
  }
}

type LeavesLook = {
  sizeMin: number;
  sizeMax: number;
  opacityMin: number;
  opacityMax: number;
  colorMin: THREE.Color;
  colorMax: THREE.Color;
  blending: THREE.Blending;
};

export class LeavesEmitter {
  public readonly id = "leaves";

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private material: THREE.Material | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;
  private velocities: Float32Array | null = null;

  private count = 0;
  private boundsRadius = 22;

  private rng = new LcgRng(777);

  private drift = 0.065;
  private jitter = 0.18;
  private maxVel = 0.18;

  private down = 0.09;

  private burstTimer = 0;
  private burstDuration = 0.4;
  private burstJitterMul = 2.4;
  private burstVelMul = 1.7;

  private baseSize = 0;
  private baseOpacity = 1;
  private baseColor = new THREE.Color(0xffffff);

  private leafSize = 0.07;
  private leafOpacity = 0.38;
  private leafColor = new THREE.Color(0xb48a5a);

  private tmpColor = new THREE.Color();

  // NEW: look profile for strong default-mode legibility
  private look: LeavesLook = {
    sizeMin: 0.06,
    sizeMax: 0.11,
    opacityMin: 0.22,
    opacityMax: 0.72,
    colorMin: new THREE.Color(0xa0703f),
    colorMax: new THREE.Color(0xffd6a3),
    blending: THREE.AdditiveBlending,
  };

  /**
   * Optional: live tuning hook.
   */
  public setLook(partial: Partial<{
    sizeMin: number;
    sizeMax: number;
    opacityMin: number;
    opacityMax: number;
    colorMin: THREE.Color | number;
    colorMax: THREE.Color | number;
    blending: THREE.Blending;
  }>): void {
    if (typeof partial.sizeMin === "number") this.look.sizeMin = partial.sizeMin;
    if (typeof partial.sizeMax === "number") this.look.sizeMax = partial.sizeMax;
    if (typeof partial.opacityMin === "number") this.look.opacityMin = partial.opacityMin;
    if (typeof partial.opacityMax === "number") this.look.opacityMax = partial.opacityMax;

    if (partial.colorMin !== undefined) {
      this.look.colorMin =
        partial.colorMin instanceof THREE.Color
          ? partial.colorMin.clone()
          : new THREE.Color(partial.colorMin);
    }
    if (partial.colorMax !== undefined) {
      this.look.colorMax =
        partial.colorMax instanceof THREE.Color
          ? partial.colorMax.clone()
          : new THREE.Color(partial.colorMax);
    }

    if (partial.blending !== undefined) this.look.blending = partial.blending;

    // Sanity clamps
    this.look.sizeMin = clamp(this.look.sizeMin, 0.0005, 10);
    this.look.sizeMax = clamp(this.look.sizeMax, this.look.sizeMin, 20);
    this.look.opacityMin = clamp(this.look.opacityMin, 0, 1);
    this.look.opacityMax = clamp(this.look.opacityMax, this.look.opacityMin, 1);
  }

  public attach(points: THREE.Points): void {
    if (this.points === points) return;

    this.detach();

    this.points = points;
    this.geometry = points.geometry as THREE.BufferGeometry;
    this.material = points.material as THREE.Material;

    const attr = this.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attr || attr.itemSize !== 3) {
      // eslint-disable-next-line no-console
      console.warn("[LeavesEmitter] BAND points has no valid position attribute.");
      this.detach();
      return;
    }

    this.posAttr = attr;

    const arr = attr.array as Float32Array | ArrayLike<number>;
    const len = arr.length | 0;
    this.count = (len / 3) | 0;

    const base = new Float32Array(len);
    for (let i = 0; i < len; i++) base[i] = Number(arr[i]);
    this.basePositions = base;

    this.simPositions = new Float32Array(len);
    this.velocities = new Float32Array(len);

    let r2Max = 0;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      const x = base[ix + 0];
      const y = base[ix + 1];
      const z = base[ix + 2];
      const d2 = x * x + y * y + z * z;
      if (d2 > r2Max) r2Max = d2;
    }
    this.boundsRadius = Math.max(1, Math.sqrt(r2Max));

    this.cacheMaterialBase();
    this.setLeafTargetsFromBase();
    this.rebuildLookFromBase();

    this.restorePositionsBase();
    this.restoreMaterialBase();
    this.resetSimToBase();
  }

  public detach(): void {
    this.points = null;
    this.geometry = null;
    this.posAttr = null;
    this.material = null;

    this.basePositions = null;
    this.simPositions = null;
    this.velocities = null;
    this.count = 0;

    this.burstTimer = 0;
  }

  public getSimPositions(): Float32Array | null {
    return this.simPositions;
  }

  public resetSimToBase(): void {
    if (!this.basePositions || !this.simPositions || !this.velocities) return;

    const base = this.basePositions;
    const sim = this.simPositions;
    const vel = this.velocities;

    for (let i = 0; i < base.length; i++) sim[i] = base[i];

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      vel[ix + 0] = this.rng.nextSigned() * 0.03;
      vel[ix + 1] = -Math.abs(this.rng.next01()) * 0.02;
      vel[ix + 2] = this.rng.nextSigned() * 0.03;
    }

    this.burstTimer = this.burstDuration;
  }

  public simulate(dt: number, strength: number): void {
    if (!this.simPositions || !this.velocities) return;
    if (!isFiniteNumber(dt) || dt <= 0) return;

    const s = clamp01(strength);
    if (s <= 0.00001) return;

    const dts = clamp(dt, 0, 1 / 15);

    const sim = this.simPositions;
    const vel = this.velocities;

    const r = this.boundsRadius;
    const r2 = r * r;

    const inBurst = this.burstTimer > 0;
    if (inBurst) this.burstTimer = Math.max(0, this.burstTimer - dts);

    const jitterMul = (inBurst ? this.burstJitterMul : 1) * this.jitter * this.drift;
    const velMul = (inBurst ? this.burstVelMul : 1) * this.drift;

    const swirl = 0.06 * s;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      vel[ix + 0] = clamp(
        vel[ix + 0] + this.rng.nextSigned() * jitterMul * dts,
        -this.maxVel,
        this.maxVel,
      );
      vel[ix + 1] = clamp(
        vel[ix + 1] + this.rng.nextSigned() * jitterMul * dts,
        -this.maxVel,
        this.maxVel,
      );
      vel[ix + 2] = clamp(
        vel[ix + 2] + this.rng.nextSigned() * jitterMul * dts,
        -this.maxVel,
        this.maxVel,
      );

      vel[ix + 1] -= this.down * s * dts;

      const x = sim[ix + 0];
      const z = sim[ix + 2];
      vel[ix + 0] += -z * swirl * dts;
      vel[ix + 2] += x * swirl * dts;

      sim[ix + 0] += vel[ix + 0] * velMul * dts;
      sim[ix + 1] += vel[ix + 1] * velMul * dts;
      sim[ix + 2] += vel[ix + 2] * velMul * dts;

      const nx = sim[ix + 0];
      const ny = sim[ix + 1];
      const nz = sim[ix + 2];
      const d2 = nx * nx + ny * ny + nz * nz;

      if (d2 > r2) {
        const inv = 1 / Math.sqrt(d2);
        sim[ix + 0] = nx * inv * r * 0.985;
        sim[ix + 1] = ny * inv * r * 0.985;
        sim[ix + 2] = nz * inv * r * 0.985;

        vel[ix + 0] *= -0.18;
        vel[ix + 1] *= -0.18;
        vel[ix + 2] *= -0.18;
      }
    }
  }

  // NEW: compositor sampling (uses Look profile for visibility)
  public sampleMaterial(morph01: number, out: MaterialState): void {
    const t = clamp01(morph01);
    const L = this.look;

    out.size = lerp(L.sizeMin, L.sizeMax, t);
    out.opacity = lerp(L.opacityMin, L.opacityMax, t);

    this.tmpColor.lerpColors(L.colorMin, L.colorMax, t);
    out.color.copy(this.tmpColor);

    out.blending = L.blending;
    out.transparent = true;
    out.depthWrite = false;
    out.sizeAttenuation = true;
  }

  // Legacy remains
  public applyPositionMorph(morph01: number): void {
    if (!this.posAttr || !this.basePositions || !this.simPositions) return;

    const t = clamp01(morph01);
    const live = this.posAttr.array as Float32Array;
    const base = this.basePositions;
    const sim = this.simPositions;

    for (let i = 0; i < live.length; i++) live[i] = lerp(base[i], sim[i], t);
    this.posAttr.needsUpdate = true;
  }

  public applyMaterialMorph(morph01: number): void {
    if (!this.material) return;

    const t = clamp01(morph01);
    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    const L = this.look;

    mat.size = lerp(L.sizeMin, L.sizeMax, t);
    mat.opacity = lerp(L.opacityMin, L.opacityMax, t);

    this.tmpColor.lerpColors(L.colorMin, L.colorMax, t);
    mat.color.copy(this.tmpColor);

    mat.transparent = true;
    mat.depthWrite = false;
    mat.sizeAttenuation = true;
    mat.needsUpdate = true;
  }

  public restorePositionsBase(): void {
    if (!this.posAttr || !this.basePositions) return;

    const live = this.posAttr.array as Float32Array;
    const base = this.basePositions;

    for (let i = 0; i < live.length; i++) live[i] = base[i];
    this.posAttr.needsUpdate = true;
  }

  public restoreMaterialBase(): void {
    if (!this.material) return;

    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    mat.size = this.baseSize;
    mat.opacity = this.baseOpacity;
    mat.color.copy(this.baseColor);

    mat.transparent = true;
    mat.depthWrite = false;
    mat.sizeAttenuation = true;
    mat.needsUpdate = true;
  }

  private cacheMaterialBase(): void {
    if (!this.material) return;

    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    this.baseSize = typeof mat.size === "number" ? mat.size : 0.04;
    this.baseOpacity = typeof mat.opacity === "number" ? mat.opacity : 1;
    this.baseColor = (mat.color ? mat.color.clone() : new THREE.Color(0xffffff)) as THREE.Color;
  }

  private setLeafTargetsFromBase(): void {
    // Keep these for legacy paths, but compositor now uses Look profile.
    this.leafSize = Math.max(this.baseSize, 0.06);
    this.leafOpacity = 0.38;
    this.leafColor = this.baseColor.clone().lerp(new THREE.Color(0xb48a5a), 0.75);
  }

  private rebuildLookFromBase(): void {
    const baseSize = Number.isFinite(this.baseSize) && this.baseSize > 0 ? this.baseSize : 0.04;
    const baseOpacity = clamp(this.baseOpacity, 0.0, 1.0);
    const baseCol = this.baseColor.clone();

    // Size: leaves should read in default filter; bias upward.
    const sizeMax = clamp(Math.max(this.leafSize, baseSize * 2.7), baseSize * 1.6, baseSize * 7.5);
    const sizeMin = clamp(sizeMax * 0.58, baseSize * 1.15, sizeMax);

    // Opacity: Normal blending often disappears on dark backgrounds.
    // We'll keep a solid min, and let morph blend handle the rest.
    const opacityMax = clamp(Math.max(0.62, this.leafOpacity * 1.35) * clamp(baseOpacity, 0.75, 1.0), 0.45, 1.0);
    const opacityMin = clamp(opacityMax * 0.40, 0.18, 0.75);

    // Color: warm amber that still feels “leafy” but luminous.
    const leaf = new THREE.Color(0xb48a5a);
    const warm = new THREE.Color(0xffd8a6);

    const colorMin = baseCol.clone().lerp(leaf, 0.72);
    const colorMax = leaf.clone().lerp(warm, 0.35);

    // Blending: Additive reads best in “default filter” for these point sprites.
    this.look = {
      sizeMin,
      sizeMax,
      opacityMin,
      opacityMax,
      colorMin,
      colorMax,
      blending: THREE.AdditiveBlending,
    };
  }
}