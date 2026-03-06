// src/systems/fieldfx/emitters/FirefliesEmitter.ts
// ============================================================
// THE STILL — FirefliesEmitter (BAND morph controller)
//
// Update (visibility / max control):
//  - Added FirefliesLook profile (size/opacity/color/blending) computed from base material
//  - sampleMaterial() now uses FirefliesLook for stronger default-mode visibility
//  - Twinkle shader now also gets uBaseOpacity/uOpacityBoost so alpha remains readable even
//    when PointMaterial opacity is conservative (and while blending between modes)
//  - Added tiny helper setLook() so you can tune without re-deriving from base
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

type FirefliesShaderUniforms = {
  uTime?: { value: number };
  uEnergy?: { value: number };
  uDensity?: { value: number };
  uSpeedMul?: { value: number };

  // NEW: keep twinkle visible in default filter even during blend-outs
  uBaseOpacity?: { value: number };
  uOpacityBoost?: { value: number };
};

type FirefliesLook = {
  sizeMin: number;
  sizeMax: number;
  opacityMin: number;
  opacityMax: number;
  colorMin: THREE.Color;
  colorMax: THREE.Color;
  blending: THREE.Blending;

  // Shader-side twinkle alpha boost (multiplies diffuseColor.a after twinkle)
  twinkleOpacityBoost: number;
};

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
  private flyOpacity = 1.0;
  private flyColor = new THREE.Color(0xcfffb0);

  private tmpColor = new THREE.Color();

  // ------------------------------------------------------------
  // Fireflies twinkle (per-point fade) via shader patching
  // ------------------------------------------------------------
  private twinkleTime = 0;
  private shaderUniforms: FirefliesShaderUniforms | null = null;

  private prevOnBeforeCompile:
    | ((shader: THREE.Shader, renderer: THREE.WebGLRenderer) => void)
    | undefined
    | null = null;

  // IMPORTANT: must be called with material bound as `this`
  private prevCustomProgramCacheKey: ((this: unknown) => string) | undefined | null =
    null;

  private readonly shaderKey = "fireflies_twinkle_v2";

  // NEW: max-control look profile (computed from base material)
  private look: FirefliesLook = {
    sizeMin: 0.05,
    sizeMax: 0.11,
    opacityMin: 0.45,
    opacityMax: 1.0,
    colorMin: new THREE.Color(0xbfffa2),
    colorMax: new THREE.Color(0xf5ffd8),
    blending: THREE.AdditiveBlending,
    twinkleOpacityBoost: 1.35,
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
    twinkleOpacityBoost: number;
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
    if (typeof partial.twinkleOpacityBoost === "number")
      this.look.twinkleOpacityBoost = partial.twinkleOpacityBoost;

    // Sanity clamps
    this.look.sizeMin = clamp(this.look.sizeMin, 0.0005, 10);
    this.look.sizeMax = clamp(this.look.sizeMax, this.look.sizeMin, 20);
    this.look.opacityMin = clamp(this.look.opacityMin, 0, 1);
    this.look.opacityMax = clamp(this.look.opacityMax, this.look.opacityMin, 1);
    this.look.twinkleOpacityBoost = clamp(this.look.twinkleOpacityBoost, 0.5, 4.0);
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
      console.warn("[FirefliesEmitter] BAND points has no valid position attribute.");
      this.detach();
      return;
    }

    this.posAttr = attr;

    const arr = attr.array as Float32Array | ArrayLike<number>;
    const len = (arr.length | 0) >>> 0;
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
    this.rebuildLookFromBase();

    // Create per-point twinkle attributes + patch shader on the shared PointsMaterial.
    this.ensureTwinkleAttributes();
    this.ensureTwinkleShader();

    this.restorePositionsBase();
    this.restoreMaterialBase();
    this.resetSimToBase();
  }

  public detach(): void {
    // Restore material hooks if we modified them.
    this.restoreTwinkleShader();

    this.points = null;
    this.geometry = null;
    this.posAttr = null;
    this.material = null;

    this.basePositions = null;
    this.simPositions = null;
    this.velocities = null;
    this.count = 0;

    this.burstTimer = 0;

    this.twinkleTime = 0;
    this.shaderUniforms = null;
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
    // We still update twinkle uniforms even if strength is tiny,
    // so transitions OUT of fireflies fade cleanly.
    if (!isFiniteNumber(dt) || dt <= 0) return;

    const dts = clamp(dt, 0, 1 / 15);

    // Drive twinkle density/speed from "strength" (which already includes audio & blend weights).
    const e = clamp01(strength);
    this.updateTwinkleUniforms(dts, e);

    // If essentially off, skip physics sim to save perf.
    if (!this.simPositions || !this.velocities) return;
    if (e <= 0.00001) return;

    const sim = this.simPositions;
    const vel = this.velocities;

    const r = this.boundsRadius;
    const r2 = r * r;

    const inBurst = this.burstTimer > 0;
    if (inBurst) this.burstTimer = Math.max(0, this.burstTimer - dts);

    const jitterMul = (inBurst ? this.burstJitterMul : 1) * this.jitter * this.drift;
    const velMul = (inBurst ? this.burstVelMul : 1) * this.drift;

    const swirl = 0.08 * e;

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

  // NEW: compositor sampling (uses Look profile)
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

  private setFireflyTargetsFromBase(): void {
    this.flySize = Math.max(this.baseSize, 0.05);
    this.flyOpacity = Math.min(1, Math.max(0.65, this.baseOpacity));
    this.flyColor = this.baseColor.clone().lerp(new THREE.Color(0xcfffb0), 0.6);
  }

  // ------------------------------------------------------------
  // Twinkle attributes (per-point)
  // ------------------------------------------------------------

  private ensureTwinkleAttributes(): void {
    if (!this.geometry || this.count <= 0) return;

    // If already present (hot reload), don't recreate.
    const hasPhase = this.geometry.getAttribute("aPhase");
    const hasSpeed = this.geometry.getAttribute("aSpeed");
    const hasDuty = this.geometry.getAttribute("aDuty");
    const hasAmp = this.geometry.getAttribute("aAmp");

    if (hasPhase && hasSpeed && hasDuty && hasAmp) return;

    const phase = new Float32Array(this.count);
    const speed = new Float32Array(this.count);
    const duty = new Float32Array(this.count);
    const amp = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      const r0 = this.rng.next01();
      const r1 = this.rng.next01();
      const r2 = this.rng.next01();
      const r3 = this.rng.next01();

      phase[i] = r0 * Math.PI * 2;
      speed[i] = lerp(0.35, 1.6, Math.pow(r1, 0.75));
      duty[i] = clamp01(Math.pow(r2, 2.2));
      amp[i] = lerp(0.65, 1.15, Math.pow(r3, 0.6));
    }

    this.geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    this.geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    this.geometry.setAttribute("aDuty", new THREE.BufferAttribute(duty, 1));
    this.geometry.setAttribute("aAmp", new THREE.BufferAttribute(amp, 1));
  }

  // ------------------------------------------------------------
  // Shader patching (PointsMaterial preserved)
  // ------------------------------------------------------------

  private ensureTwinkleShader(): void {
    if (!this.material) return;

    const mat = this.material as unknown as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    const anyMat = mat as any;
    if (anyMat.__firefliesTwinklePatched === this.shaderKey) return;

    // IMPORTANT: store originals
    this.prevOnBeforeCompile = mat.onBeforeCompile;
    this.prevCustomProgramCacheKey = (mat as any).customProgramCacheKey;

    mat.onBeforeCompile = (shader: THREE.Shader, renderer: THREE.WebGLRenderer) => {
      // keep any prior mods
      if (this.prevOnBeforeCompile) this.prevOnBeforeCompile(shader, renderer);

      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uEnergy = { value: 0 };
      shader.uniforms.uDensity = { value: 0.15 };
      shader.uniforms.uSpeedMul = { value: 1.0 };

      // NEW
      shader.uniforms.uBaseOpacity = { value: 1.0 };
      shader.uniforms.uOpacityBoost = { value: 1.0 };

      this.shaderUniforms = shader.uniforms as unknown as FirefliesShaderUniforms;

      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          `
attribute float aPhase;
attribute float aSpeed;
attribute float aDuty;
attribute float aAmp;

uniform float uTime;
uniform float uEnergy;
uniform float uDensity;
uniform float uSpeedMul;

// NEW
uniform float uBaseOpacity;
uniform float uOpacityBoost;

varying float vTwinkle;
varying float vOpacityMul;

void main() {
`,
        )
        .replace(
          "#include <begin_vertex>",
          `
#include <begin_vertex>

float tA = uTime * aSpeed * uSpeedMul + aPhase;
float tB = uTime * (aSpeed * 0.37 + 0.11) * uSpeedMul + aPhase * 1.73;

float pA = 0.5 + 0.5 * sin(tA);
float pB = 0.5 + 0.5 * sin(tB);

float raw = clamp(pA * (0.55 + 0.45 * pB), 0.0, 1.0);

float d = clamp(uDensity, 0.0, 1.0);
float gate = step(aDuty, d);

float edge = 1.0 - (0.30 + 0.55 * d);
float tw = smoothstep(edge, 1.0, raw);

float e = clamp(uEnergy, 0.0, 1.0);
float energyMul = mix(0.35, 1.0, e);

vTwinkle = clamp(tw * gate * aAmp * energyMul, 0.0, 1.25);

// NEW: let alpha remain readable even if material opacity is conservative.
vOpacityMul = clamp(uBaseOpacity * uOpacityBoost, 0.0, 2.0);
`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          `
varying float vTwinkle;
varying float vOpacityMul;

void main() {
`,
        )
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `
vec4 diffuseColor = vec4( diffuse, opacity );

// Twinkle drives alpha strongly (readable in default filter)
diffuseColor.a *= clamp(vTwinkle, 0.0, 1.0) * vOpacityMul;

// Slight brightness lift (but not purely bloom-dependent)
diffuseColor.rgb *= mix(0.90, 1.18, clamp(vTwinkle, 0.0, 1.0));
`,
        );
    };

    // ✅ FIX: if original cacheKey relies on `this`, we must call it with `this=mat`
    (mat as any).customProgramCacheKey = function (this: unknown): string {
      let base = "base";
      if (typeof (anyMat as any).__firefliesPrevCacheKey === "function") {
        try {
          base = String((anyMat as any).__firefliesPrevCacheKey.call(this));
        } catch {
          base = "base";
        }
      } else if (typeof (anyMat as any).__firefliesPrevCacheKey === "string") {
        base = String((anyMat as any).__firefliesPrevCacheKey);
      }
      return `${base}|${(anyMat as any).__firefliesShaderKey}`;
    };

    // store prev on the material for the wrapper above
    anyMat.__firefliesPrevCacheKey = this.prevCustomProgramCacheKey;
    anyMat.__firefliesShaderKey = this.shaderKey;

    anyMat.__firefliesTwinklePatched = this.shaderKey;
    mat.needsUpdate = true;
  }

  private restoreTwinkleShader(): void {
    if (!this.material) return;

    const mat = this.material as unknown as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    const anyMat = mat as any;
    if (anyMat.__firefliesTwinklePatched !== this.shaderKey) return;

    // Restore onBeforeCompile
    if (this.prevOnBeforeCompile === undefined) {
      (mat as any).onBeforeCompile = undefined;
    } else {
      mat.onBeforeCompile = this.prevOnBeforeCompile ?? undefined;
    }

    // Restore customProgramCacheKey
    if (this.prevCustomProgramCacheKey == null) {
      delete (mat as any).customProgramCacheKey;
    } else {
      (mat as any).customProgramCacheKey = this.prevCustomProgramCacheKey;
    }

    delete anyMat.__firefliesTwinklePatched;
    delete anyMat.__firefliesPrevCacheKey;
    delete anyMat.__firefliesShaderKey;

    mat.needsUpdate = true;

    this.prevOnBeforeCompile = null;
    this.prevCustomProgramCacheKey = null;
    this.shaderUniforms = null;
  }

  private updateTwinkleUniforms(dt: number, energy01: number): void {
    this.twinkleTime += Math.max(0, dt);

    const u = this.shaderUniforms;
    if (!u) return;

    const density = clamp01(lerp(0.12, 0.92, Math.pow(energy01, 0.85)));
    const speedMul = lerp(0.30, 2.10, Math.pow(energy01, 0.95));

    // NEW: use Look profile to keep “default filter” visible
    // - Base opacity comes from compositor (out.opacity), but shader doesn’t know that.
    // - So we feed a conservative proxy here (max of baseOpacity + look min), plus boost.
    const baseOpacityProxy = clamp(this.baseOpacity, 0.25, 1.0);
    const opacityBoost = clamp(this.look.twinkleOpacityBoost, 0.5, 4.0);

    if (u.uTime) u.uTime.value = this.twinkleTime;
    if (u.uEnergy) u.uEnergy.value = energy01;
    if (u.uDensity) u.uDensity.value = density;
    if (u.uSpeedMul) u.uSpeedMul.value = speedMul;

    if (u.uBaseOpacity) u.uBaseOpacity.value = baseOpacityProxy;
    if (u.uOpacityBoost) u.uOpacityBoost.value = opacityBoost;
  }

  private rebuildLookFromBase(): void {
    // Base-driven defaults: visible without bloom, but still “firefly” not “flare gun”
    const baseSize = Number.isFinite(this.baseSize) && this.baseSize > 0 ? this.baseSize : 0.04;
    const baseOpacity = clamp(this.baseOpacity, 0.0, 1.0);

    // Size: in default filter, small points disappear. We bias up a little.
    const sizeMax = clamp(Math.max(this.flySize, baseSize * 2.4), baseSize * 1.6, baseSize * 6.5);
    const sizeMin = clamp(sizeMax * 0.62, baseSize * 1.15, sizeMax);

    // Opacity: allow a real presence even when base stars are dim.
    const opacityMax = clamp(Math.max(this.flyOpacity, 0.9) * clamp(baseOpacity, 0.75, 1.0), 0.55, 1.0);
    const opacityMin = clamp(opacityMax * 0.50, 0.22, 0.75);

    // Color: keep your greenish tint, but give it a warmer rim so it reads as “alive”
    const green = this.flyColor.clone();
    const warm = new THREE.Color(0xfff6c7);

    const colorMin = this.baseColor.clone().lerp(green, 0.58);
    const colorMax = green.clone().lerp(warm, 0.22);

    this.look = {
      sizeMin,
      sizeMax,
      opacityMin,
      opacityMax,
      colorMin,
      colorMax,
      blending: THREE.AdditiveBlending,
      twinkleOpacityBoost: 1.35, // strong default-filter legibility
    };
  }
}