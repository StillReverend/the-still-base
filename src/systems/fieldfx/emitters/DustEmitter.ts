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
  constructor(seed = 123456789) {
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

export class DustEmitter {
  public readonly id = "dust";

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private material: THREE.Material | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;
  private velocities: Float32Array | null = null;

  private count = 0;
  private boundsRadius = 22;

  private rng = new LcgRng(4201337);
  private driftSpeed = 0.06;
  private jitter = 0.02;
  private maxVel = 0.12;

  private burstTimer = 0;
  private burstDuration = 0.28;
  private burstJitterMul = 4.0;
  private burstVelMul = 2.2;

  private baseSize = 0;
  private baseOpacity = 1;
  private baseColor = new THREE.Color(0xffffff);

  private dustSize = 0.05;
  private dustOpacity = 0.22;
  private dustColor = new THREE.Color(0xffffff);

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
      console.warn("[DustEmitter] BAND points has no valid position attribute.");
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
    this.setDustTargetsFromBase();

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
      vel[ix + 0] = this.rng.nextSigned() * 0.05;
      vel[ix + 1] = this.rng.nextSigned() * 0.02;
      vel[ix + 2] = this.rng.nextSigned() * 0.05;
    }

    this.burstTimer = this.burstDuration;
  }

  public simulate(dt: number, strength: number): void {
    if (!this.simPositions || !this.velocities || !this.basePositions) return;
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

    const jitterMul = (inBurst ? this.burstJitterMul : 1) * this.jitter * this.driftSpeed;
    const velMul = (inBurst ? this.burstVelMul : 1) * this.driftSpeed;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      vel[ix + 0] = clamp(vel[ix + 0] + this.rng.nextSigned() * jitterMul * dts, -this.maxVel, this.maxVel);
      vel[ix + 1] = clamp(vel[ix + 1] + this.rng.nextSigned() * (jitterMul * 0.6) * dts, -this.maxVel, this.maxVel);
      vel[ix + 2] = clamp(vel[ix + 2] + this.rng.nextSigned() * jitterMul * dts, -this.maxVel, this.maxVel);

      sim[ix + 0] += vel[ix + 0] * velMul * dts;
      sim[ix + 1] += vel[ix + 1] * velMul * dts;
      sim[ix + 2] += vel[ix + 2] * velMul * dts;

      const x = sim[ix + 0];
      const y = sim[ix + 1];
      const z = sim[ix + 2];
      const d2 = x * x + y * y + z * z;

      if (d2 > r2) {
        const inv = 1 / Math.sqrt(d2);
        const nx = x * inv;
        const ny = y * inv;
        const nz = z * inv;

        sim[ix + 0] = nx * r * 0.985;
        sim[ix + 1] = ny * r * 0.985;
        sim[ix + 2] = nz * r * 0.985;

        vel[ix + 0] *= -0.25;
        vel[ix + 1] *= -0.25;
        vel[ix + 2] *= -0.25;
      }
    }
  }

  // NEW: compositor sampling
  public sampleMaterial(morph01: number, out: MaterialState): void {
    const t = clamp01(morph01);

    out.size = lerp(this.baseSize, this.dustSize, t);
    out.opacity = lerp(this.baseOpacity, this.dustOpacity, t);

    this.tmpColor.lerpColors(this.baseColor, this.dustColor, t);
    out.color.copy(this.tmpColor);

    out.blending = THREE.NormalBlending;
    out.transparent = true;
    out.depthWrite = false;
    out.sizeAttenuation = true;
  }

  // Legacy (unused by compositor now)
  public applyPositionMorph(morph01: number): void {
    if (!this.posAttr || !this.basePositions || !this.simPositions) return;

    const t = clamp01(morph01);

    const live = this.posAttr.array as Float32Array;
    const base = this.basePositions;
    const sim = this.simPositions;

    for (let i = 0; i < live.length; i++) {
      live[i] = lerp(base[i], sim[i], t);
    }

    this.posAttr.needsUpdate = true;
  }

  public applyMaterialMorph(morph01: number): void {
    if (!this.material) return;

    const t = clamp01(morph01);
    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    mat.size = lerp(this.baseSize, this.dustSize, t);
    mat.opacity = lerp(this.baseOpacity, this.dustOpacity, t);

    this.tmpColor.lerpColors(this.baseColor, this.dustColor, t);
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

  private setDustTargetsFromBase(): void {
    this.dustSize = Math.max(this.baseSize, 0.045);
    this.dustOpacity = Math.min(this.baseOpacity, 0.22);
    this.dustColor = this.baseColor.clone().lerp(new THREE.Color(0xffffff), 0.25);
  }
}