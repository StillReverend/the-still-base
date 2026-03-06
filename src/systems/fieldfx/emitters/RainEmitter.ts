// src/systems/fieldfx/emitters/RainEmitter.ts
// ============================================================
// THE STILL — RainEmitter (BAND morph controller)
// ------------------------------------------------------------
// Update (visibility / max control):
//  - Adds RainLook profile (size/opacity/color/blending/attenuation) derived from base
//  - sampleMaterial() now uses RainLook so rain reads in DEFAULT filter mode
//  - Adds setLook() to tune quickly (and keep emitter values centralized)
//  - Keeps your Option B "true density" shader gating intact
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
  constructor(seed = 13371337) {
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

type RainLook = {
  sizeMin: number;
  sizeMax: number;
  opacityMin: number;
  opacityMax: number;
  colorMin: THREE.Color;
  colorMax: THREE.Color;
  blending: THREE.Blending;
  sizeAttenuation: boolean;
};

export class RainEmitter {
  public readonly id = "rain";

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private material: THREE.Material | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;
  private velocities: Float32Array | null = null;

  // Stable per-particle “sheet” / wind band
  private windBias: Float32Array | null = null;
  private sheetBand: Float32Array | null = null;

  private count = 0;
  private boundsRadius = 22;

  // ✅ Y-wrap bounds (computed from base positions)
  private yMin = -22;
  private yMax = 22;
  private ySpan = 44;

  private rng = new LcgRng(1200457);

  // ----------------------------------------------------------
  // WORLD-SCALE MOTION TUNING (units/sec)
  // ----------------------------------------------------------
  private fallSpeed = 1850; // downward, units/sec
  private windSpeed = 260; // lateral, units/sec
  private shearSpeed = 130; // z drift tied to x, units/sec (scaled down)
  private jitterSpeed = 55; // micro jitter, units/sec

  // “Sheet” shaping
  private shearFactor = 0.00012; // keeps x->z shear sane at large x

  // Burst
  private burstTimer = 0;
  private burstDuration = 0.32;
  private burstSpeedMul = 1.65;
  private burstJitterMul = 1.35;

  // ----------------------------------------------------------
  // Smoothness: semi-fixed timestep
  // ----------------------------------------------------------
  private stepAcc = 0;
  private readonly fixedStep = 1 / 60; // seconds
  private readonly maxSubSteps = 5; // safety cap per frame
  private readonly largeDtReset = 0.25; // seconds (tab switch / throttle)

  // ----------------------------------------------------------
  // True density (Option B)
  // ----------------------------------------------------------
  private density01 = 1.0; // 0..1, defaults to fully visible
  private densitySoftness = 0.03; // soft edge so density ramps don’t flicker

  private baseSize = 0;
  private baseOpacity = 1;
  private baseColor = new THREE.Color(0xffffff);

  private rainSize = 0.045; // legacy (kept)
  private rainOpacity = 0.99; // legacy (kept)
  private rainColor = new THREE.Color(0xeaf3ff); // legacy (kept)

  private tmpColor = new THREE.Color();

  // NEW: look profile for legibility in DEFAULT filter mode
  private look: RainLook = {
    sizeMin: 0.06,
    sizeMax: 0.11,
    opacityMin: 0.12,
    opacityMax: 0.38,
    colorMin: new THREE.Color(0x9fd2ff),
    colorMax: new THREE.Color(0xeaf3ff),
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
  };

  /**
   * Optional tuning hook (for maximum control without spelunking).
   */
  public setLook(partial: Partial<{
    sizeMin: number;
    sizeMax: number;
    opacityMin: number;
    opacityMax: number;
    colorMin: THREE.Color | number;
    colorMax: THREE.Color | number;
    blending: THREE.Blending;
    sizeAttenuation: boolean;
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
    if (typeof partial.sizeAttenuation === "boolean")
      this.look.sizeAttenuation = partial.sizeAttenuation;

    // sanity clamps
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
      console.warn("[RainEmitter] BAND points has no valid position attribute.");
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
    this.velocities = new Float32Array(len); // kept for compatibility (not relied on for motion)
    this.windBias = new Float32Array(this.count);
    this.sheetBand = new Float32Array(this.count);

    let r2Max = 0;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      const x = base[ix + 0];
      const y = base[ix + 1];
      const z = base[ix + 2];

      const d2 = x * x + y * y + z * z;
      if (d2 > r2Max) r2Max = d2;

      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }

    this.boundsRadius = Math.max(1, Math.sqrt(r2Max));

    // ✅ Compute Y wrap bounds from base distribution (robust on non-perfect spheres)
    this.yMin = Number.isFinite(yMin) ? yMin : -this.boundsRadius;
    this.yMax = Number.isFinite(yMax) ? yMax : this.boundsRadius;
    this.ySpan = Math.max(1e-3, this.yMax - this.yMin);

    // ✅ Ensure stable per-point random attribute exists for density gating
    this.ensureDensityAttribute();

    // ✅ Patch material shader once (idempotent)
    this.patchMaterialForDensity();

    // ✅ Apply current density to shader uniforms (defaults to 1)
    this.applyDensityToMaterial();

    this.cacheMaterialBase();
    this.setRainTargetsFromBase();
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
    this.windBias = null;
    this.sheetBand = null;

    this.count = 0;
    this.burstTimer = 0;

    this.yMin = -22;
    this.yMax = 22;
    this.ySpan = 44;

    this.stepAcc = 0;
  }

  public getSimPositions(): Float32Array | null {
    return this.simPositions;
  }

  /**
   * True density control (Option B)
   * - 1.0 = all points visible (default)
   * - 0.05 = ~5% of points visible (sparse drizzle)
   */
  public setDensity01(density01: number, softness01?: number): void {
    const d = clamp01(density01);
    this.density01 = d;

    if (typeof softness01 === "number" && Number.isFinite(softness01)) {
      // Keep softness in a sane range. Too small can look “steppy”; too big looks foggy.
      this.densitySoftness = clamp(softness01, 0.005, 0.10);
    }

    this.applyDensityToMaterial();
  }

  public resetSimToBase(): void {
    if (
      !this.basePositions ||
      !this.simPositions ||
      !this.velocities ||
      !this.windBias ||
      !this.sheetBand
    )
      return;

    const base = this.basePositions;
    const sim = this.simPositions;
    const vel = this.velocities;

    for (let i = 0; i < base.length; i++) sim[i] = base[i];

    // Stable per-particle wind bias + banding. No popping: only set on reset.
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      // Legacy vel init (kept for future use / compatibility)
      vel[ix + 0] = this.rng.nextSigned() * 0.02;
      vel[ix + 1] = -Math.abs(this.rng.next01()) * 0.25 - 0.05;
      vel[ix + 2] = this.rng.nextSigned() * 0.02;

      this.windBias[i] = this.rng.nextSigned();

      // “sheet band”: 0..1 with slight clustering, stable
      const u = this.rng.next01();
      const band = u * u; // bias toward 0
      this.sheetBand[i] = band;

      // Start some drops slightly above their base Y so the "arrival" reads immediately
      const lift = this.rng.next01() * (this.ySpan * 0.08);
      sim[ix + 1] = base[ix + 1] + lift;
    }

    this.burstTimer = this.burstDuration;

    // Reset accumulator so we don't get a “catch-up wobble” on entry.
    this.stepAcc = 0;
  }

  public simulate(dt: number, strength: number): void {
    if (!this.simPositions || !this.windBias || !this.sheetBand || !this.basePositions) return;
    if (!isFiniteNumber(dt) || dt <= 0) return;

    const s = clamp01(strength);
    if (s <= 0.00001) return;

    // If the tab was inactive, dt can be huge. Do NOT catch up.
    // Reset accumulator and skip this frame's integration to avoid a visible “jump”.
    if (dt >= this.largeDtReset) {
      this.stepAcc = 0;
      return;
    }

    this.stepAcc += clamp(dt, 0, 0.1);

    let steps = 0;

    while (this.stepAcc >= this.fixedStep && steps < this.maxSubSteps) {
      this.integrateStep(this.fixedStep, s);
      this.stepAcc -= this.fixedStep;
      steps++;
    }

    if (steps === 0 && this.stepAcc > 0) {
      const partial = clamp(this.stepAcc, 0, this.fixedStep);
      this.integrateStep(partial, s);
      this.stepAcc = 0;
    }

    if (steps >= this.maxSubSteps) {
      this.stepAcc = 0;
    }
  }

  private integrateStep(dts: number, strength01: number): void {
    if (!this.simPositions || !this.windBias || !this.sheetBand || !this.basePositions) return;

    const s = clamp01(strength01);
    if (s <= 0.00001) return;

    const sim = this.simPositions;
    const base = this.basePositions;

    const inBurst = this.burstTimer > 0;
    if (inBurst) this.burstTimer = Math.max(0, this.burstTimer - dts);

    const speedMul = inBurst ? this.burstSpeedMul : 1;
    const jitterMul = inBurst ? this.burstJitterMul : 1;

    // ✅ Y-wrap thresholding (bottom->top respawn)
    const yMin = this.yMin;
    const yMax = this.yMax;
    const yMargin = this.ySpan * 0.08;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      const bias = this.windBias[i];
      const band = this.sheetBand[i]; // 0..1

      // Per-drop variation: keeps “sheets” without obvious stripes
      const fall = this.fallSpeed * s * speedMul * (0.78 + band * 0.55);
      const wind = this.windSpeed * s * speedMul * (0.55 + band * 0.75);

      // Micro jitter
      sim[ix + 0] += this.rng.nextSigned() * this.jitterSpeed * s * jitterMul * dts;
      sim[ix + 2] += this.rng.nextSigned() * this.jitterSpeed * s * jitterMul * dts;

      // Wind
      sim[ix + 0] += bias * wind * dts;

      // Shear
      const x = sim[ix + 0];
      sim[ix + 2] += x * this.shearSpeed * s * speedMul * dts * this.shearFactor;

      // Fall
      sim[ix + 1] -= fall * dts;

      // ✅ Wrap when falling below bottom
      if (sim[ix + 1] < yMin - yMargin) {
        const bx = base[ix + 0];
        const bz = base[ix + 2];

        sim[ix + 0] = bx + this.rng.nextSigned() * (this.boundsRadius * 0.02);
        sim[ix + 1] = yMax + this.rng.next01() * yMargin;
        sim[ix + 2] = bz + this.rng.nextSigned() * (this.boundsRadius * 0.02);
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
    out.sizeAttenuation = L.sizeAttenuation;
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
    mat.sizeAttenuation = L.sizeAttenuation;

    // Keep density uniforms in sync even when updating material
    this.applyDensityToMaterial();

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
    // Keep your original readabilty decision for rain (world-scale, non-attenuated)
    mat.sizeAttenuation = false;

    // Keep density uniforms in sync even when restoring material state
    this.applyDensityToMaterial();

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

  private setRainTargetsFromBase(): void {
    // Legacy fields (no longer used by compositor, but kept for any fallback usage)
    this.rainSize = Math.max(0.06, Math.min(0.095, this.baseSize * 1.55));
    this.rainOpacity = Math.min(0.42, Math.max(0.24, this.baseOpacity * 0.36));
    this.rainColor = this.baseColor.clone().lerp(new THREE.Color(0x9fd2ff), 0.6);
  }

  private rebuildLookFromBase(): void {
    const baseSize = Number.isFinite(this.baseSize) && this.baseSize > 0 ? this.baseSize : 0.04;
    const baseOpacity = clamp(this.baseOpacity, 0.0, 1.0);
    const baseCol = this.baseColor.clone();

    // Rain reads best as "thin bright" points. In default filter mode,
    // we need additive + enough opacity to survive tonemapping without bloom.
    const sizeMax = clamp(Math.max(0.085, baseSize * 2.2), baseSize * 1.4, baseSize * 6.5);
    const sizeMin = clamp(sizeMax * 0.72, baseSize * 1.05, sizeMax);

    // Opacity: keep modest so it doesn't become snow. Additive + density does the work.
    const opMax = clamp(Math.max(0.28, baseOpacity * 0.36), 0.12, 0.60);
    const opMin = clamp(opMax * 0.42, 0.05, opMax);

    // Color: cool blue-white for "wet" sparkle.
    const cool = new THREE.Color(0x9fd2ff);
    const white = new THREE.Color(0xf4fbff);

    const cMin = baseCol.clone().lerp(cool, 0.55);
    const cMax = cool.clone().lerp(white, 0.55);

    this.look = {
      sizeMin,
      sizeMax,
      opacityMin: opMin,
      opacityMax: opMax,
      colorMin: cMin,
      colorMax: cMax,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    };
  }

  // ==========================================================
  // Option B internals: stable per-point random + shader gating
  // ==========================================================

  private ensureDensityAttribute(): void {
    if (!this.geometry) return;
    if (this.count <= 0) return;

    const name = "aRand";

    const existing = this.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (
      existing &&
      existing.itemSize === 1 &&
      (existing.array as any)?.length === this.count
    ) {
      return;
    }

    const arr = new Float32Array(this.count);

    // Use our seeded RNG for stable, deterministic density order
    const seedRng = new LcgRng(9001);

    for (let i = 0; i < this.count; i++) {
      arr[i] = seedRng.next01();
    }

    const attr = new THREE.BufferAttribute(arr, 1);
    attr.setUsage(THREE.StaticDrawUsage);

    this.geometry.setAttribute(name, attr);
  }

  private patchMaterialForDensity(): void {
    if (!this.material) return;

    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    const ud = mat.userData as any;
    if (ud.__stillDensityPatched) return;
    ud.__stillDensityPatched = true;

    const prevOnBeforeCompile = mat.onBeforeCompile?.bind(mat);

    mat.onBeforeCompile = (shader: THREE.Shader) => {
      if (prevOnBeforeCompile) prevOnBeforeCompile(shader);

      // Attach uniforms and initialize to CURRENT values (so first compile respects current density)
      shader.uniforms.uDensity = { value: clamp01(this.density01) };
      shader.uniforms.uDensitySoft = {
        value: clamp(this.densitySoftness, 0.005, 0.10),
      };

      ud.__stillDensityShader = shader;

      // --- Vertex: pass aRand to fragment ---
      shader.vertexShader =
        `attribute float aRand;\nvarying float vRand;\n` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n  vRand = aRand;`,
        );

      if (!shader.vertexShader.includes("vRand = aRand")) {
        shader.vertexShader = shader.vertexShader.replace(
          "void main() {",
          "void main() {\n  vRand = aRand;",
        );
      }

      // --- Fragment: gate alpha by density ---
      shader.fragmentShader =
        `uniform float uDensity;\nuniform float uDensitySoft;\nvarying float vRand;\n` +
        shader.fragmentShader;

      const needle = "gl_FragColor = vec4( diffuse, opacity );";
      const gate = `
  float d = clamp(uDensity, 0.0, 1.0);
  float soft = clamp(uDensitySoft, 0.001, 0.25);

  // vRand in [0..1]. If vRand <= d => visible.
  // We fade out over [d .. d+soft] so density ramps are smooth.
  float mask = 1.0 - smoothstep(d, min(1.0, d + soft), vRand);

  gl_FragColor.a *= mask;
  if (gl_FragColor.a <= 0.001) discard;`;

      if (shader.fragmentShader.includes(needle)) {
        shader.fragmentShader = shader.fragmentShader.replace(
          needle,
          `${needle}${gate}`,
        );
      } else {
        shader.fragmentShader = shader.fragmentShader.replace("}", `${gate}\n}`);
      }
    };

    // Force a recompile so onBeforeCompile runs
    mat.needsUpdate = true;
  }

  private applyDensityToMaterial(): void {
    if (!this.material) return;

    const mat = this.material as THREE.PointsMaterial;
    if (!(mat as any).isPointsMaterial) return;

    const ud = mat.userData as any;
    const shader: THREE.Shader | undefined = ud.__stillDensityShader;

    if (shader?.uniforms?.uDensity) {
      shader.uniforms.uDensity.value = clamp01(this.density01);
    }
    if (shader?.uniforms?.uDensitySoft) {
      shader.uniforms.uDensitySoft.value = clamp(this.densitySoftness, 0.005, 0.10);
    }
  }
}