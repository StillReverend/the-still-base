// src/systems/fieldfx/emitters/EmbersEmitter.ts
// ============================================================
// THE STILL — EmbersEmitter (BAND morph controller)
// ------------------------------------------------------------
// IMPORTANT: This is NOT a standalone particle spawner.
// It does NOT create its own THREE.Points.
//
// Instead, it:
//  - Attaches to the existing BAND THREE.Points created by StarSystem
//  - Caches pristine “base” snapshot of positions + material
//  - Runs ember-style sim into a separate sim buffer
//  - Applies a morph between base -> ember sim (0..1)
//  - Restores baseline exactly when returning to stars
//
// Update (visibility / max control):
//  - Added an EmbersLook profile (size/opacity/color/blending ranges)
//  - sampleMaterial() now uses EmbersLook (instead of blindly trusting params.size=3.0 etc.)
//  - Defaults are computed from the BAND base material for strong visibility in “default filter”
// ============================================================

import * as THREE from "three";

export type EmbersParams = {
  driftUp: number;
  driftOut: number;
  swirl: number;
  jitter: number;
  damping: number;

  riseHeight: number;
  fadeStart01: number;
  fadeEnd01: number;
  respawnJitter: number;
  respawnKick: number;

  // Legacy “material targets” (now used as hints when building EmbersLook)
  size: number;
  opacity: number;
  color: number;
  blending: THREE.Blending;
};

export const DEFAULT_EMBERS: EmbersParams = {
  driftUp: 31,
  driftOut: 10,
  swirl: 10,
  jitter: 10,
  damping: 1.25,

  riseHeight: 520,
  fadeStart01: 0.65,
  fadeEnd01: 1.0,
  respawnJitter: 8,
  respawnKick: 1.25,

  // These are treated as “hints” now (clamped against base star material)
  size: 3.0,
  opacity: 1.31,
  color: 0xff0000,
  blending: THREE.AdditiveBlending,
};

type MaterialSnapshot = {
  size: number;
  opacity: number;
  color: THREE.Color;
  blending: THREE.Blending;
  transparent: boolean;
  depthWrite: boolean;
};

type MaterialState = {
  size: number;
  opacity: number;
  color: THREE.Color;
  blending: THREE.Blending;
  transparent: boolean;
  depthWrite: boolean;
  sizeAttenuation: boolean;
};

type EmbersLook = {
  sizeMin: number;
  sizeMax: number;
  opacityMin: number;
  opacityMax: number;
  colorMin: THREE.Color;
  colorMax: THREE.Color;
  blending: THREE.Blending;
};

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export class EmbersEmitter {
  public readonly id = "embers";

  private readonly params: EmbersParams;

  private points: THREE.Points | null = null;
  private geom: THREE.BufferGeometry | null = null;
  private mat: THREE.PointsMaterial | null = null;

  private posAttr: THREE.BufferAttribute | null = null;
  private positions: Float32Array | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;
  private velocities: Float32Array | null = null;
  private seeds: Float32Array | null = null;

  private count = 0;

  private vOrigin = new THREE.Vector3();
  private vRadial = new THREE.Vector3();
  private vTang = new THREE.Vector3();

  private matBase: MaterialSnapshot | null = null;

  private emberColor = new THREE.Color();
  private tmpColor = new THREE.Color();

  // New: max-control look profile (computed from base material)
  private look: EmbersLook = {
    sizeMin: 0.06,
    sizeMax: 0.12,
    opacityMin: 0.90,
    opacityMax: 1.0,
    colorMin: new THREE.Color(0xff6a00),
    colorMax: new THREE.Color(0xffc08a),
    blending: THREE.AdditiveBlending,
  };

  constructor(params: Partial<EmbersParams> = {}) {
    this.params = { ...DEFAULT_EMBERS, ...params };
    this.emberColor.setHex(this.params.color);
  }

  /**
   * Optional: allow live tuning without rebuilding code.
   * Keep this small and “safe”: we clamp internally.
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
      if (partial.colorMin instanceof THREE.Color) this.look.colorMin = partial.colorMin.clone();
      else this.look.colorMin = new THREE.Color(partial.colorMin);
    }
    if (partial.colorMax !== undefined) {
      if (partial.colorMax instanceof THREE.Color) this.look.colorMax = partial.colorMax.clone();
      else this.look.colorMax = new THREE.Color(partial.colorMax);
    }

    if (partial.blending !== undefined) this.look.blending = partial.blending;

    // Sanity clamps
    this.look.sizeMin = clamp(this.look.sizeMin, 0.0005, 10);
    this.look.sizeMax = clamp(this.look.sizeMax, this.look.sizeMin, 20);
    this.look.opacityMin = clamp(this.look.opacityMin, 0, 1);
    this.look.opacityMax = clamp(this.look.opacityMax, this.look.opacityMin, 1);
  }

  public attach(points: THREE.Points): void {
    this.points = points;
    this.geom = points.geometry as THREE.BufferGeometry;
    this.mat = points.material as THREE.PointsMaterial;

    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos || !(pos.array instanceof Float32Array) || pos.itemSize !== 3) {
      throw new Error("[EmbersEmitter] BAND position attribute must be Float32Array itemSize=3.");
    }

    this.posAttr = pos;
    this.positions = pos.array as Float32Array;
    this.count = (this.positions.length / 3) | 0;

    this.matBase = {
      size: this.mat.size,
      opacity: this.mat.opacity,
      color: this.mat.color.clone(),
      blending: this.mat.blending,
      transparent: this.mat.transparent,
      depthWrite: this.mat.depthWrite,
    };

    this.basePositions = new Float32Array(this.positions.length);
    this.basePositions.set(this.positions);

    this.simPositions = new Float32Array(this.positions.length);
    this.simPositions.set(this.positions);

    this.velocities = new Float32Array(this.positions.length);
    this.seeds = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      const s = Math.random();
      this.seeds[i] = s;

      const k = i * 3;
      this.velocities[k + 0] = (Math.random() * 2 - 1) * 0.5;
      this.velocities[k + 1] = (Math.random() * 2 - 1) * 0.5;
      this.velocities[k + 2] = (Math.random() * 2 - 1) * 0.5;
    }

    // New: compute a strong, default-filter-visible look profile from base
    this.rebuildLookFromBase();
  }

  public detach(): void {
    this.points = null;
    this.geom = null;
    this.mat = null;
    this.posAttr = null;
    this.positions = null;

    this.basePositions = null;
    this.simPositions = null;
    this.velocities = null;
    this.seeds = null;

    this.count = 0;
    this.matBase = null;
  }

  public getSimPositions(): Float32Array | null {
    return this.simPositions;
  }

  public resetSimToBase(): void {
    if (!this.basePositions || !this.simPositions || !this.velocities) return;
    this.simPositions.set(this.basePositions);
    this.velocities.fill(0);
  }

  public simulate(dt: number, strength01: number): void {
    if (!this.basePositions || !this.simPositions || !this.velocities || !this.seeds) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    const s01 = clamp01(strength01);
    if (s01 <= 0.000001) return;

    const p = this.params;

    const driftUp = p.driftUp * s01;
    const driftOut = p.driftOut * s01;
    const swirl = p.swirl * s01;
    const jitter = p.jitter * s01;

    const riseHeight = Math.max(1e-6, p.riseHeight);
    const respawnJitter = Math.max(0, p.respawnJitter);
    const respawnKick = Math.max(0, p.respawnKick);

    const damp = Math.exp(-Math.max(0, p.damping) * dt);

    for (let i = 0; i < this.count; i++) {
      const k = i * 3;

      const x = this.simPositions[k + 0];
      const y = this.simPositions[k + 1];
      const z = this.simPositions[k + 2];

      this.vRadial.set(x, y, z);
      const rLen = this.vRadial.length();
      if (rLen > 1e-6) this.vRadial.multiplyScalar(1 / rLen);

      this.vOrigin.set(0, 1, 0);
      if (Math.abs(this.vRadial.y) > 0.95) this.vOrigin.set(1, 0, 0);

      this.vTang.copy(this.vRadial).cross(this.vOrigin);
      const tLen = this.vTang.length();
      if (tLen > 1e-6) this.vTang.multiplyScalar(1 / tLen);

      const seed = this.seeds[i];

      const vx = this.velocities[k + 0];
      const vy = this.velocities[k + 1];
      const vz = this.velocities[k + 2];

      let ax = this.vRadial.x * driftOut;
      let ay = this.vRadial.y * driftOut;
      let az = this.vRadial.z * driftOut;

      ay += driftUp;

      ax += this.vTang.x * swirl;
      ay += this.vTang.y * swirl;
      az += this.vTang.z * swirl;

      const jx = (seed * 2 - 1) * jitter;
      const jy = (((seed * 7.13) % 1) * 2 - 1) * jitter;
      const jz = (((seed * 3.71) % 1) * 2 - 1) * jitter;

      const nvx = (vx + (ax + jx) * dt) * damp;
      const nvy = (vy + (ay + jy) * dt) * damp;
      const nvz = (vz + (az + jz) * dt) * damp;

      this.velocities[k + 0] = nvx;
      this.velocities[k + 1] = nvy;
      this.velocities[k + 2] = nvz;

      let nx = x + nvx * dt;
      let ny = y + nvy * dt;
      let nz = z + nvz * dt;

      const by = this.basePositions[k + 1];
      const dy = ny - by;

      if (dy > riseHeight) {
        const bx = this.basePositions[k + 0];
        const bz = this.basePositions[k + 2];

        const rx = (Math.random() * 2 - 1) * respawnJitter;
        const ry = (Math.random() * 2 - 1) * (respawnJitter * 0.25);
        const rz = (Math.random() * 2 - 1) * respawnJitter;

        nx = bx + rx;
        ny = by + ry;
        nz = bz + rz;

        this.velocities[k + 0] = (Math.random() * 2 - 1) * respawnKick;
        this.velocities[k + 1] = Math.abs(Math.random()) * respawnKick;
        this.velocities[k + 2] = (Math.random() * 2 - 1) * respawnKick;
      }

      this.simPositions[k + 0] = nx;
      this.simPositions[k + 1] = ny;
      this.simPositions[k + 2] = nz;
    }
  }

  // ---------------------------------------------------------------------------
  // Compositor sampling (no direct writes to geometry/material)
  // ---------------------------------------------------------------------------

  public sampleMaterial(morph01: number, out: MaterialState): void {
    if (!this.matBase) return;

    const t = clamp01(morph01);
    const L = this.look;

    out.size = lerp(L.sizeMin, L.sizeMax, t);
    out.opacity = lerp(L.opacityMin, L.opacityMax, t);

    this.tmpColor.lerpColors(L.colorMin, L.colorMax, t);
    out.color.copy(this.tmpColor);

    out.blending = L.blending;

    // Embers should be “light-emitting” in vibe-space:
    out.transparent = true;
    out.depthWrite = false;
    out.sizeAttenuation = true;
  }

  // ---------------------------------------------------------------------------
  // Legacy methods remain (safe), but FieldFXSystem no longer uses them.
  // ---------------------------------------------------------------------------

  public applyPositionMorph(morph01: number): void {
    if (!this.positions || !this.basePositions || !this.simPositions || !this.posAttr) return;

    const tGlobal = clamp01(morph01);

    const rise = Math.max(1e-6, this.params.riseHeight);
    const fadeStart = clamp01(this.params.fadeStart01);
    const fadeEnd = Math.max(fadeStart + 1e-6, clamp01(this.params.fadeEnd01));

    for (let i = 0; i < this.count; i++) {
      const k = i * 3;

      const dy = this.simPositions[k + 1] - this.basePositions[k + 1];
      const u = clamp01(dy / rise);

      let fade = 0;
      if (u > fadeStart) {
        const ft = clamp01((u - fadeStart) / (fadeEnd - fadeStart));
        fade = smoothstep01(ft);
      }

      const tLocal = tGlobal * (1 - fade);
      const inv = 1 - tLocal;

      this.positions[k + 0] = this.basePositions[k + 0] * inv + this.simPositions[k + 0] * tLocal;
      this.positions[k + 1] = this.basePositions[k + 1] * inv + this.simPositions[k + 1] * tLocal;
      this.positions[k + 2] = this.basePositions[k + 2] * inv + this.simPositions[k + 2] * tLocal;
    }

    this.posAttr.needsUpdate = true;
  }

  public applyMaterialMorph(morph01: number): void {
    if (!this.mat || !this.matBase) return;

    const t = clamp01(morph01);

    // Mirror compositor behavior roughly (but this path should not be used anymore)
    const L = this.look;

    this.mat.size = lerp(L.sizeMin, L.sizeMax, t);
    this.mat.opacity = lerp(L.opacityMin, L.opacityMax, t);

    this.tmpColor.lerpColors(L.colorMin, L.colorMax, t);
    this.mat.color.copy(this.tmpColor);

    this.mat.blending = L.blending;
    this.mat.transparent = true;
    this.mat.depthWrite = false;

    this.mat.needsUpdate = true;
  }

  public restoreMaterialBase(): void {
    if (!this.mat || !this.matBase) return;
    this.mat.size = this.matBase.size;
    this.mat.opacity = this.matBase.opacity;
    this.mat.color.copy(this.matBase.color);
    this.mat.blending = this.matBase.blending;
    this.mat.transparent = this.matBase.transparent;
    this.mat.depthWrite = this.matBase.depthWrite;
    this.mat.needsUpdate = true;
  }

  public restorePositionsBase(): void {
    if (!this.positions || !this.basePositions || !this.posAttr) return;
    this.positions.set(this.basePositions);
    this.posAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Look building (this is the “default filter visibility” lever)
  // ---------------------------------------------------------------------------

  private rebuildLookFromBase(): void {
    if (!this.matBase) return;

    const baseSize = typeof this.matBase.size === "number" ? this.matBase.size : 0.04;
    const baseOpacity = typeof this.matBase.opacity === "number" ? this.matBase.opacity : 1;

    // Legacy hint values (clamped into sane world-space sizes)
    const sizeHintMul = Number.isFinite(this.params.size) ? this.params.size : 2.5;
    const opacityHint = Number.isFinite(this.params.opacity) ? this.params.opacity : 1.0;

    // “Default filter” goal: visible without needing bloom.
    // Sizes are clamped to avoid the old 3.0 becoming planet-sized.
    const sizeMax = clamp(baseSize * sizeHintMul, baseSize * 1.4, baseSize * 8.0);
    const sizeMin = clamp(sizeMax * 0.55, baseSize * 1.05, sizeMax);

    const opacityMax = clamp(opacityHint, 0.45, 1.0) * clamp(baseOpacity, 0.75, 1.0);
    const opacityMin = clamp(opacityMax * 0.55, 0.22, 0.75);

    // Colors: ember core bright, but keep a softer “start” color so ramp feels nice.
    this.emberColor.setHex(this.params.color);
    const warmWhite = new THREE.Color(0xffffff);

    const colorMin = this.matBase.color.clone().lerp(this.emberColor, 0.55);
    const colorMax = this.emberColor.clone().lerp(warmWhite, 0.18);

    this.look = {
      sizeMin,
      sizeMax,
      opacityMin,
      opacityMax,
      colorMin,
      colorMax,
      blending: this.params.blending ?? THREE.AdditiveBlending,
    };
  }
}