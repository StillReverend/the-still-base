import * as THREE from "three";

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
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
  constructor(seed = 1337) {
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

export class FirefliesEmitter {
  public readonly id = "fireflies";

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private material: THREE.Material | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;
  private velocities: Float32Array | null = null;

  private count = 0;
  private boundsRadius = 22;

  private rng = new LcgRng(9001);

  private drift = 0.08;
  private jitter = 0.35;
  private maxVel = 0.22;

  private burstTimer = 0;
  private burstDuration = 0.35;
  private burstJitterMul = 2.8;
  private burstVelMul = 1.9;

  private baseSize = 0;
  private baseOpacity = 1;
  private baseColor = new THREE.Color(0xffffff);

  private flySize = 0.06;
  private flyOpacity = 0.85;
  private flyColor = new THREE.Color(0xcfffb0);

  private tmpColor = new THREE.Color();

  public attach(points: THREE.Points): void {
    if (this.points === points) return;

    this.detach();

    this.points = points;
    this.geometry = points.geometry as THREE.BufferGeometry;
    this.material = points.material as THREE.Material;

    const attr = this.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attr || attr.itemSize !== 3) {
      // eslint-disable-next-line no-console
      console.warn("[FirefliesEmitter] BAND points has no valid position attribute.");
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
    this.setFireflyTargetsFromBase();

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
      vel[ix + 0] = this.rng.nextSigned() * 0.04;
      vel[ix + 1] = this.rng.nextSigned() * 0.04;
      vel[ix + 2] = this.rng.nextSigned() * 0.04;
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

    const swirl = 0.08 * s;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      vel[ix + 0] = clamp(vel[ix + 0] + this.rng.nextSigned() * jitterMul * dts, -this.maxVel, this.maxVel);
      vel[ix + 1] = clamp(vel[ix + 1] + this.rng.nextSigned() * jitterMul * dts, -this.maxVel, this.maxVel);
      vel[ix + 2] = clamp(vel[ix + 2] + this.rng.nextSigned() * jitterMul * dts, -this.maxVel, this.maxVel);

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

        vel[ix + 0] *= -0.2;
        vel[ix + 1] *= -0.2;
        vel[ix + 2] *= -0.2;
      }
    }
  }

  // NEW: compositor sampling
  public sampleMaterial(morph01: number, out: MaterialState): void {
    const t = clamp01(morph01);

    out.size = lerp(this.baseSize, this.flySize, t);
    out.opacity = lerp(this.baseOpacity, this.flyOpacity, t);

    this.tmpColor.lerpColors(this.baseColor, this.flyColor, t);
    out.color.copy(this.tmpColor);

    out.blending = THREE.AdditiveBlending;
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

    mat.size = lerp(this.baseSize, this.flySize, t);
    mat.opacity = lerp(this.baseOpacity, this.flyOpacity, t);

    this.tmpColor.lerpColors(this.baseColor, this.flyColor, t);
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

  private setFireflyTargetsFromBase(): void {
    this.flySize = Math.max(this.baseSize, 0.05);
    this.flyOpacity = Math.min(1, Math.max(0.65, this.baseOpacity));
    this.flyColor = this.baseColor.clone().lerp(new THREE.Color(0xcfffb0), 0.6);
  }
}