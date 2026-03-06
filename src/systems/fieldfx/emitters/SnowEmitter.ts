// src/systems/fieldfx/emitters/SnowEmitter.ts
// ============================================================
// THE STILL — SnowEmitter (BAND morph controller)
// ------------------------------------------------------------
// Uses existing BAND points. No new point clouds.
//
// Updates (Mar 2026 - Option B parity + visibility):
// - Density shader patch now matches RainEmitter gating logic (mask = 1 - smoothstep(d, d+soft, vRand))
//   so: density=1 => visible, density small => sparse (and no inverted behavior).
// - sampleMaterial now uses a SnowLook profile (like RainEmitter) so snow reads in DEFAULT filter mode.
// - Adds setLook() + rebuildLookFromBase() for quick tuning and consistent defaults.
// - Keeps deterministic motion + fixed-step accumulator + large-dt reset.
// ============================================================

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
  constructor(seed = 20240303) {
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

// Small sin LUT so we avoid Math.sin in tight loops.
const SIN_LUT_SIZE = 1024;
const SIN_LUT_MASK = SIN_LUT_SIZE - 1;
const SIN_LUT = (() => {
  const arr = new Float32Array(SIN_LUT_SIZE);
  for (let i = 0; i < SIN_LUT_SIZE; i++) {
    arr[i] = Math.sin((i / SIN_LUT_SIZE) * Math.PI * 2);
  }
  return arr;
})();

const lutSin = (phase: number): number => SIN_LUT[phase & SIN_LUT_MASK];
const lutCos = (phase: number): number => SIN_LUT[(phase + (SIN_LUT_SIZE >> 2)) & SIN_LUT_MASK];

type SnowLook = {
  sizeMin: number;
  sizeMax: number;
  opacityMin: number;
  opacityMax: number;
  colorMin: THREE.Color;
  colorMax: THREE.Color;
  blending: THREE.Blending;
  sizeAttenuation: boolean;
};

export class SnowEmitter {
  public readonly id = "snow";

  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private material: THREE.Material | null = null;

  private basePositions: Float32Array | null = null;
  private simPositions: Float32Array | null = null;

  // Kept for compatibility (not required for motion anymore).
  private velocities: Float32Array | null = null;

  // Per-flake deterministic parameters
  private phase: Int32Array | null = null; // 0..SIN_LUT_SIZE-1
  private phaseSpeed: Float32Array | null = null; // cycles/sec (in LUT space)
  private driftBias: Float32Array | null = null; // -1..1
  private swirlAmt: Float32Array | null = null; // 0..1
  private fallVar: Float32Array | null = null; // 0..1
  private jitterAmt: Float32Array | null = null; // 0..1

  private count = 0;
  private boundsRadius = 22;

  // ✅ Y-wrap bounds (computed from base positions)
  private yMin = -22;
  private yMax = 22;
  private ySpan = 44;

  private rng = new LcgRng(5050);

  // ----------------------------------------------------------
  // WORLD-SCALE MOTION TUNING (units/sec)
  // ----------------------------------------------------------
  // Snow should be slower than rain, with more lateral drift.
  private fallSpeed = 520; // units/sec downward baseline
  private windSpeed = 180; // units/sec lateral baseline
  private swirlSpeed = 220; // units/sec circular drift baseline
  private microJitterSpeed = 35; // units/sec micro variation (deterministic)

  // “Sheeting” / spatial sanity at large x values
  private shearSpeed = 85; // units/sec
  private shearFactor = 0.00012; // keep x->z shear sane at large x

  // Burst (soft “flakes appear” arrival)
  private burstTimer = 0;
  private burstDuration = 0.45;
  private burstSpeedMul = 1.25;
  private burstJitterMul = 1.15;

  // ----------------------------------------------------------
  // Fixed-step accumulator (tab-switch jitter killer)
  // ----------------------------------------------------------
  private accumulator = 0;
  private fixedStep = 1 / 60;
  private maxSubSteps = 5;

  // If we see a huge dt (tab switch), we reset the sim clock/accumulator.
  private largeDtResetSec = 0.25;

  // ----------------------------------------------------------
  // True density (Option B)
  // ----------------------------------------------------------
  private density01 = 1.0; // 0..1, defaults to fully visible
  private densitySoftness = 0.03; // soft edge so density ramps don’t flicker

  private baseSize = 0;
  private baseOpacity = 1;
  private baseColor = new THREE.Color(0xffffff);

  // legacy targets (kept)
  private snowSize = 0.07;
  private snowOpacity = 0.99;
  private snowColor = new THREE.Color(0xffffed);

  private tmpColor = new THREE.Color();

  // NEW: look profile for legibility in DEFAULT filter mode
  private look: SnowLook = {
    sizeMin: 0.065,
    sizeMax: 0.11,
    opacityMin: 0.08,
    opacityMax: 0.32,
    colorMin: new THREE.Color(0xf6fbff),
    colorMax: new THREE.Color(0xffffed),
    blending: THREE.NormalBlending,
    sizeAttenuation: false,
  };

  /**
   * Optional tuning hook (for maximum control without spelunking).
   */
  public setLook(
    partial: Partial<{
      sizeMin: number;
      sizeMax: number;
      opacityMin: number;
      opacityMax: number;
      colorMin: THREE.Color | number;
      colorMax: THREE.Color | number;
      blending: THREE.Blending;
      sizeAttenuation: boolean;
    }>,
  ): void {
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
    if (typeof partial.sizeAttenuation === "boolean") this.look.sizeAttenuation = partial.sizeAttenuation;

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
      console.warn("[SnowEmitter] BAND points has no valid position attribute.");
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

    // Deterministic per-flake state
    this.phase = new Int32Array(this.count);
    this.phaseSpeed = new Float32Array(this.count);
    this.driftBias = new Float32Array(this.count);
    this.swirlAmt = new Float32Array(this.count);
    this.fallVar = new Float32Array(this.count);
    this.jitterAmt = new Float32Array(this.count);

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
    this.setSnowTargetsFromBase();
    this.rebuildLookFromBase();

    this.restorePositionsBase();
    this.restoreMaterialBase();

    // Reset integrator state
    this.accumulator = 0;

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

    this.phase = null;
    this.phaseSpeed = null;
    this.driftBias = null;
    this.swirlAmt = null;
    this.fallVar = null;
    this.jitterAmt = null;

    this.count = 0;
    this.burstTimer = 0;

    this.accumulator = 0;

    this.yMin = -22;
    this.yMax = 22;
    this.ySpan = 44;
  }

  public getSimPositions(): Float32Array | null {
    return this.simPositions;
  }

  /**
   * True density control (Option B)
   * - 1.0 = all points visible (default)
   * - 0.05 = ~5% of points visible (sparse flakes)
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
      !this.phase ||
      !this.phaseSpeed ||
      !this.driftBias ||
      !this.swirlAmt ||
      !this.fallVar ||
      !this.jitterAmt
    )
      return;

    const base = this.basePositions;
    const sim = this.simPositions;
    const vel = this.velocities;

    for (let i = 0; i < base.length; i++) sim[i] = base[i];

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      // Legacy vel init (kept for compatibility / future use)
      vel[ix + 0] = this.rng.nextSigned() * 0.02;
      vel[ix + 1] = -Math.abs(this.rng.next01()) * 0.02;
      vel[ix + 2] = this.rng.nextSigned() * 0.02;

      // Stable drift bias + swirl params (no popping)
      this.driftBias[i] = this.rng.nextSigned();
      this.swirlAmt[i] = this.rng.next01(); // 0..1
      this.fallVar[i] = this.rng.next01(); // 0..1
      this.jitterAmt[i] = this.rng.next01(); // 0..1

      // Phase in LUT space + speed (cycles/sec mapped into LUT increments)
      this.phase[i] = (this.rng.next01() * SIN_LUT_SIZE) | 0;
      this.phaseSpeed[i] = 0.18 + this.rng.next01() * 0.55; // slow, floaty

      // Start some flakes slightly above their base Y for immediate read
      const lift = this.rng.next01() * (this.ySpan * 0.06);
      sim[ix + 1] = base[ix + 1] + lift;
    }

    this.burstTimer = this.burstDuration;
    this.accumulator = 0;
  }

  public simulate(dt: number, strength: number): void {
    if (
      !this.simPositions ||
      !this.basePositions ||
      !this.phase ||
      !this.phaseSpeed ||
      !this.driftBias ||
      !this.swirlAmt ||
      !this.fallVar ||
      !this.jitterAmt
    )
      return;

    if (!isFiniteNumber(dt) || dt <= 0) return;

    const s = clamp01(strength);
    if (s <= 0.00001) return;

    // Large-dt reset (tab switch / throttled timers)
    if (dt >= this.largeDtResetSec) {
      this.accumulator = 0;
      // Also end burst so we don't re-trigger weirdness on return.
      this.burstTimer = 0;
      return;
    }

    // Accumulate and step at fixed rate for smooth visuals
    this.accumulator += clamp(dt, 0, 0.1);

    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.step(this.fixedStep, s);
      this.accumulator -= this.fixedStep;
      steps++;
    }

    // If we fell behind badly, drop remainder (prevents spirals)
    if (steps >= this.maxSubSteps) {
      this.accumulator = 0;
    }
  }

  private step(dts: number, strength01: number): void {
    if (
      !this.simPositions ||
      !this.basePositions ||
      !this.phase ||
      !this.phaseSpeed ||
      !this.driftBias ||
      !this.swirlAmt ||
      !this.fallVar ||
      !this.jitterAmt
    )
      return;

    const sim = this.simPositions;
    const base = this.basePositions;

    // Burst (soft arrival)
    const inBurst = this.burstTimer > 0;
    if (inBurst) this.burstTimer = Math.max(0, this.burstTimer - dts);

    const speedMul = inBurst ? this.burstSpeedMul : 1;
    const jitterMul = inBurst ? this.burstJitterMul : 1;

    // Y-wrap thresholding
    const yMin = this.yMin;
    const yMax = this.yMax;
    const yMargin = this.ySpan * 0.10;

    const s = clamp01(strength01);

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;

      // Advance phase deterministically in LUT space
      const inc = this.phaseSpeed[i] * SIN_LUT_SIZE * dts;
      let ph = (this.phase[i] + (inc | 0)) & SIN_LUT_MASK;
      this.phase[i] = ph;

      const si = lutSin(ph);
      const ci = lutCos(ph);

      const bias = this.driftBias[i];
      const swirlAmt = this.swirlAmt[i];
      const fallVar = this.fallVar[i];
      const jitAmt = this.jitterAmt[i];

      const fall = this.fallSpeed * (0.72 + fallVar * 0.55) * s * speedMul;
      const wind = this.windSpeed * (0.55 + swirlAmt * 0.80) * s * speedMul;
      const swirl = this.swirlSpeed * (0.35 + swirlAmt * 0.95) * s * speedMul;

      // Deterministic “micro jitter” from a second phase offset (no RNG)
      const ph2 = (ph + 173) & SIN_LUT_MASK;
      const jx = lutSin(ph2) * (this.microJitterSpeed * (0.25 + jitAmt) * s * jitterMul);
      const jz = lutCos(ph2) * (this.microJitterSpeed * (0.25 + jitAmt) * s * jitterMul);

      // Lateral drift: wind bias + swirl
      sim[ix + 0] += (bias * wind + ci * swirl + jx) * dts;
      sim[ix + 2] += (bias * (wind * 0.65) + si * swirl + jz) * dts;

      // Gentle shear: gives snow a faint “curtain” angle
      const x = sim[ix + 0];
      sim[ix + 2] += x * this.shearSpeed * s * speedMul * dts * this.shearFactor;

      // Fall
      sim[ix + 1] -= fall * dts;

      // Wrap bottom -> top
      if (sim[ix + 1] < yMin - yMargin) {
        const bx = base[ix + 0];
        const bz = base[ix + 2];

        const spread = this.boundsRadius * 0.04;

        sim[ix + 0] = bx + this.rng.nextSigned() * spread;
        sim[ix + 1] = yMax + this.rng.next01() * yMargin;
        sim[ix + 2] = bz + this.rng.nextSigned() * spread;

        // Keep drift params stable, but re-randomize phase a touch so clumps don't sync
        this.phase[i] = (this.phase[i] + ((this.rng.next01() * 97) | 0)) & SIN_LUT_MASK;
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

    // Keep density uniforms in sync during morphs too
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

    // keep snow readable at BAND scale by default
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

  private setSnowTargetsFromBase(): void {
    // legacy values (kept)
    this.snowSize = Math.max(this.baseSize * 1.35, 0.065);
    this.snowOpacity = Math.min(0.5, Math.max(0.24, this.baseOpacity * 0.99));
    this.snowColor = this.baseColor.clone().lerp(new THREE.Color(0xffffed), 0.58);
  }

  private rebuildLookFromBase(): void {
    const baseSize = Number.isFinite(this.baseSize) && this.baseSize > 0 ? this.baseSize : 0.04;
    const baseOpacity = clamp(this.baseOpacity, 0.0, 1.0);
    const baseCol = this.baseColor.clone();

    // Snow needs to read as larger, softer points than stars, but not as bright as rain.
    const sizeMax = clamp(Math.max(0.095, baseSize * 2.35), baseSize * 1.6, baseSize * 7.5);
    const sizeMin = clamp(sizeMax * 0.68, baseSize * 1.15, sizeMax);

    // Opacity: keep moderate, density drives “amount of weather”.
    const opMax = clamp(Math.max(0.22, baseOpacity * 0.30), 0.10, 0.55);
    const opMin = clamp(opMax * 0.38, 0.04, opMax);

    // Color: slightly warm white helps snow differentiate from rain.
    const warm = new THREE.Color(0xffffed);
    const cool = new THREE.Color(0xf6fbff);

    const cMin = baseCol.clone().lerp(cool, 0.45);
    const cMax = cool.clone().lerp(warm, 0.55);

    this.look = {
      sizeMin,
      sizeMax,
      opacityMin: opMin,
      opacityMax: opMax,
      colorMin: cMin,
      colorMax: cMax,
      blending: THREE.NormalBlending,
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
    if (existing && existing.itemSize === 1 && (existing.array as any)?.length === this.count) {
      return;
    }

    const arr = new Float32Array(this.count);

    // Use a deterministic seed separate from motion RNG
    const seedRng = new LcgRng(9002);

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

      // Initialize to CURRENT density settings
      shader.uniforms.uDensity = { value: clamp01(this.density01) };
      shader.uniforms.uDensitySoft = { value: clamp(this.densitySoftness, 0.005, 0.10) };

      ud.__stillDensityShader = shader;

      // --- Vertex: pass aRand to fragment ---
      shader.vertexShader =
        `attribute float aRand;\nvarying float vRand;\n` +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n  vRand = aRand;`,
        );

      if (!shader.vertexShader.includes("vRand = aRand")) {
        shader.vertexShader = shader.vertexShader.replace("void main() {", "void main() {\n  vRand = aRand;");
      }

      // --- Fragment: gate alpha by density (matches RainEmitter) ---
      shader.fragmentShader =
        `uniform float uDensity;\nuniform float uDensitySoft;\nvarying float vRand;\n` + shader.fragmentShader;

      const needle = "gl_FragColor = vec4( diffuse, opacity );";
      const gate = `
  float d = clamp(uDensity, 0.0, 1.0);
  float soft = clamp(uDensitySoft, 0.001, 0.25);

  // vRand in [0..1]. If vRand <= d => visible.
  // Fade out over [d .. d+soft] so density ramps stay smooth.
  float mask = 1.0 - smoothstep(d, min(1.0, d + soft), vRand);

  gl_FragColor.a *= mask;
  if (gl_FragColor.a <= 0.001) discard;`;

      if (shader.fragmentShader.includes(needle)) {
        shader.fragmentShader = shader.fragmentShader.replace(needle, `${needle}${gate}`);
      } else {
        shader.fragmentShader = shader.fragmentShader.replace("}", `${gate}\n}`);
      }
    };

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