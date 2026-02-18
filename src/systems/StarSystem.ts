// ============================================================
// THE STILL — P03 (StarSystem v0 + BAND)
// StarSystem.ts
// ------------------------------------------------------------
// NOW:
//  - FAR stars: static-ish, subtle
//  - NEAR stars: pool with brightness modulated by audio “intensity” (0..1)
//    + ritual external lane + shockwave pulse
//  - BAND stars: true 3D spherical shell starfield driven by low/mid/high bands
//    (all stars exist; per-star brightness + tint modulated smoothly, no popping)
//
// BAND rules:
//  - If audio is NOT playing: BAND goes true dark (writes zeros)
//  - NEAR ritual lane stays as-is (BAND does not conflict)
//  - No per-frame geometry rebuild; stable cached arrays
//
// Ryan spec (Feb 2026):
//  - Core can glow/swell at low intensity, but NEAR stars should NOT “pop” early.
//  - NEAR activates only after an intensity threshold (with feather) is crossed.
// ============================================================

import * as THREE from "three";

type StarSystemOptions = {
  // Overall
  exclusionRadius?: number;

  // FAR stars
  farCount?: number;
  farRadius?: number;
  farSize?: number;
  farColor?: number;

  // NEAR stars
  nearCount?: number;
  nearInnerRadius?: number;
  nearOuterRadius?: number;
  nearSize?: number;
  nearBaseColor?: number;

  // Starting intensity (0..1). Recommend 0.0 for true darkness until audio.
  nearReveal01?: number;

  // BAND stars (new)
  bandCount?: number;
  bandInnerRadius?: number;
  bandOuterRadius?: number;
  bandSize?: number;
};

type AudioFrame = {
  energy?: number;
  low?: number;
  mid?: number;
  high?: number;
};

type PulseMode = "sphere" | "planeXZ";

type RadialPulse = {
  t: number; // elapsed seconds since start (includes delay time)
  delay: number; // seconds before pulse becomes active
  speed: number; // units/sec
  width: number; // base band thickness in world units
  strength: number; // 0..1
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const safe01 = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return clamp01(n);
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const gate01 = (v: number, on: number, feather: number): number => {
  const f = Math.max(1e-6, feather);
  return smoothstep(on, on + f, clamp01(v));
};

type RGB01 = { r: number; g: number; b: number };

const hexToRgb01 = (hex: number): RGB01 => {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
};

const normalize3 = (a: number, b: number, c: number): { a: number; b: number; c: number } => {
  const s = a + b + c;
  if (s <= 1e-8) return { a: 0, b: 0, c: 0 };
  return { a: a / s, b: b / s, c: c / s };
};

const smoothAR = (current: number, target: number, attackPerSec: number, releasePerSec: number, dt: number): number => {
  const up = target > current;
  const k = up ? attackPerSec : releasePerSec;
  const t = 1 - Math.exp(-Math.max(0, k) * Math.max(0, dt));
  return lerp(current, target, t);
};

export class StarSystem {
  // FAR
  private farPoints: THREE.Points;
  private farGeom: THREE.BufferGeometry;
  private farMat: THREE.PointsMaterial;

  // NEAR
  private nearPoints: THREE.Points;
  private nearGeom: THREE.BufferGeometry;
  private nearMat: THREE.PointsMaterial;

  // NEAR attributes
  private nearPositions: Float32Array;
  private nearColors: Float32Array;

  // Cached per-star radii for wave math
  private nearRadiiSphere: Float32Array; // full 3D radius
  private nearRadiiXZ: Float32Array; // XZ-plane radius

  // Stable per-star brightness variance
  private nearVariance: Float32Array;

  // BAND (new)
  private bandPoints: THREE.Points;
  private bandGeom: THREE.BufferGeometry;
  private bandMat: THREE.PointsMaterial;

  private bandPositions: Float32Array;
  private bandColors: Float32Array;

  private bandRadii: Float32Array;
  private bandVariance: Float32Array;
  private bandPhase: Float32Array; // stable shimmer phase

  // Per-star weights (cached)
  private bandWLow: Float32Array;
  private bandWMid: Float32Array;
  private bandWHigh: Float32Array;

  // BAND spatial info
  private bandInnerRadius = 0;
  private bandOuterRadius = 0;

  // State
  private readonly exclusionRadius: number;

  // Breathing field intensity (0..1)
  private nearIntensity01 = 0.0;
  private nearTargetIntensity01 = 0.0;
  private nearIntensityEase = 7.9; // slightly liquid by default

  // External override lane (ritual), separate from audio
  private externalTarget01 = 0.0;
  private externalTouchedThisFrame = false;
  private externalDecay = 1.05; // per-second decay toward 0 when not touched

  // Audio cache
  private isAudioPlaying = false;
  private lastAudio: Required<AudioFrame> = { energy: 0, low: 0, mid: 0, high: 0 };
  private audioDriven = true;

  // Wave family
  private pulses: RadialPulse[] = [];
  private maxPulses = 6;
  private nearMaxRadius = 0;

  // Pulse mode
  private pulseMode: PulseMode = "sphere";

  // Pulse visibility tuning
  private pulseDimBase = 0.55;
  private pulseColorTint = { r: 0.10, g: 0.95, b: 1.0 };
  private pulseMaxBoost = 2.2;

  // Cosmic shaping knobs
  private pulseFrontWidthMul = 0.55;
  private pulseBackWidthMul = 1.25;
  private pulseFrontRidgeMul = 0.38;
  private pulseFrontRidgeWidthMul = 0.18;

  // After-ripple
  private afterRippleEnabled = true;
  private afterRippleDelaySec = 1.0;
  private afterRippleStrengthMul = 0.35;
  private afterRippleWidthMul = 1.25;
  private afterRippleSpeedMul = 0.92;

  // ==========================================================
  // NEAR ACTIVATION THRESHOLD (so Core can glow first)
  // ==========================================================
  // NEAR does not contribute visually until energy crosses this floor.
  // (Keeps NEAR quiet during low/ambient playback.)
  private nearEnergyOn = 0.50;
  private nearEnergyFeather = 0.10;

  // If you want NEAR to be *truly* 0 until activation, leave this at 0.
  // If you ever want a faint dust after activation, you can raise it slightly.
  private nearMinVisibleV = 0.0;

  // Shape once active
  private nearCurvePow = 1.0;

  // ==========================================================
  // BAND KNOBS (keep these together for Harmony + tuning)
  // ==========================================================

  // Palette (Harmony will override later)
  private bandColorLow: RGB01 = hexToRgb01(0xffffed); // low
  private bandColorMid: RGB01 = hexToRgb01(0xffdd70); // mid
  private bandColorHigh: RGB01 = hexToRgb01(0xffdd70); // high

  // Gating + curves (drives the smoothed levels BEFORE visibility thresholds)
  private bandGateLow = 0.06;
  private bandGateMid = 0.08;
  private bandGateHigh = 0.07;

  // ----------------------------------------------------------
  // Spatial mapping
  // ----------------------------------------------------------

  // Band mixing / overlap shaping (soft thirds)
  // overlap01: 0 = sharper zones, 1 = very blended
  private bandOverlap01 = 0.31;

  // Optional per-band biases (future Harmony “mixing”)
  private bandBiasLow = 1.0;
  private bandBiasMid = 1.0;
  private bandBiasHigh = 1.0;

  // ----------------------------------------------------------
  // Gain staging (how bright BAND can get once active)
  // ----------------------------------------------------------

  private bandGainMaster = 1.35;
  private bandGainLow = 1.10;
  private bandGainMid = 1.00;
  private bandGainHigh = 1.25;

  // ----------------------------------------------------------
  // Visibility thresholds — THIS is what keeps BAND empty
  // until the music is actually full.
  // ----------------------------------------------------------

  // Per-band “turn on” levels (0..1).
  // Stars in that band do NOT appear at all until crossed.
  private bandOnLow = 0.10;
  private bandOnMid = 0.40;
  private bandOnHigh = 0.05;

  // Softness of the on-ramp (0.02 = crisp, 0.06 = smoother)
  private bandOnFeather = 0.05;

  // Global gate: BAND is completely off until overall energy passes this.
  // This is the main verse stays empty, chorus fills the STILL control.
  private bandEnergyOn = 0.05;
  private bandEnergyFeather = 0.08;

  // Final brightness floor.
  // Even if math produces a tiny value, we write 0 below this.
  private bandMinVisibleV = 0.03;

  // ----------------------------------------------------------
  // Response shaping (after bands are ON)
  // ----------------------------------------------------------

  // Curves (emotional response)
  private bandCurveLow = 1.20; // 1.0 - 1.3
  private bandCurveMid = 0.90; // 0.9 - 1.1
  private bandCurveHigh = 0.85; // 0.7 – 1.0

  // Attack/Release per band (per-second)
  private bandAttackLow = 1.8;
  private bandReleaseLow = 0.9;

  private bandAttackMid = 6.0;
  private bandReleaseMid = 3.5;

  private bandAttackHigh = 6.0;
  private bandReleaseHigh = 3.0;

  // ----------------------------------------------------------
  // High shimmer (only applies once highs are truly active)
  // ----------------------------------------------------------

  private bandHighShimmerAmt = 0.10; // 0..1 (multiplies high level)
  private bandHighShimmerHz = 0.75; // cycles/sec (visual shimmer speed)

  // ----------------------------------------------------------
  // Dark snap (write zeros)
  // ----------------------------------------------------------

  private bandSnapEps = 0.0025;

  // ----------------------------------------------------------
  // BAND smoothed state (runtime)
  // ----------------------------------------------------------

  private bandLevelLow = 0.0;
  private bandLevelMid = 0.0;
  private bandLevelHigh = 0.0;

  // Cached “did something change?”
  private bandLastWriteKey = -1;

  // Internal clock for shimmer (seconds)
  private tSec = 0;

  constructor(scene: THREE.Scene, options: StarSystemOptions = {}) {
    this.exclusionRadius = Math.max(0, options.exclusionRadius ?? 0);

    // ----------------------------
    // FAR (sparse)
    // ----------------------------
    const farCount = Math.max(0, options.farCount ?? 79);
    const farRadius = Math.max(1, options.farRadius ?? 7777);
    const farSize = Math.max(0.1, options.farSize ?? 1.25);
    const farColor = options.farColor ?? 0xffdd70;

    this.farGeom = new THREE.BufferGeometry();
    const farPos = this.makeShellPositions({
      count: farCount,
      innerRadius: this.exclusionRadius,
      outerRadius: farRadius,
    });

    this.farGeom.setAttribute("position", new THREE.BufferAttribute(farPos, 3));

    this.farMat = new THREE.PointsMaterial({
      color: farColor,
      size: farSize,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.79,
      depthWrite: false,
    });

    this.farPoints = new THREE.Points(this.farGeom, this.farMat);
    this.farPoints.name = "Stars_FAR";
    scene.add(this.farPoints);

    // ----------------------------
    // NEAR (dense pool)
    // ----------------------------
    const nearCount = Math.max(0, options.nearCount ?? 777);
    const nearInnerRadius = Math.max(this.exclusionRadius, options.nearInnerRadius ?? 5000);
    const nearOuterRadius = Math.max(nearInnerRadius + 1, options.nearOuterRadius ?? 10000);
    const nearSize = Math.max(0.1, options.nearSize ?? 1.65);
    const nearBaseColor = options.nearBaseColor ?? 0xffdd70;

    this.nearMaxRadius = nearOuterRadius;

    this.nearGeom = new THREE.BufferGeometry();

    this.nearPositions = this.makeShellPositions({
      count: nearCount,
      innerRadius: nearInnerRadius,
      outerRadius: nearOuterRadius,
    });

    this.nearGeom.setAttribute("position", new THREE.BufferAttribute(this.nearPositions, 3));

    // Vertex colors (we control brightness per-star here)
    this.nearColors = new Float32Array(nearCount * 3);
    this.nearGeom.setAttribute("color", new THREE.BufferAttribute(this.nearColors, 3));

    this.nearMat = new THREE.PointsMaterial({
      color: nearBaseColor, // multiplier
      vertexColors: true,
      size: nearSize,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });

    this.nearPoints = new THREE.Points(this.nearGeom, this.nearMat);
    this.nearPoints.name = "Stars_NEAR";
    scene.add(this.nearPoints);

    // Precompute radii + variance
    this.nearRadiiSphere = new Float32Array(nearCount);
    this.nearRadiiXZ = new Float32Array(nearCount);
    this.nearVariance = new Float32Array(nearCount);

    for (let i = 0; i < nearCount; i++) {
      const x = this.nearPositions[i * 3 + 0];
      const y = this.nearPositions[i * 3 + 1];
      const z = this.nearPositions[i * 3 + 2];

      this.nearRadiiSphere[i] = Math.sqrt(x * x + y * y + z * z);
      this.nearRadiiXZ[i] = Math.sqrt(x * x + z * z);

      this.nearVariance[i] = 0.82 + Math.random() * 0.18;
    }

    // Starting intensity (recommend 0)
    const start = clamp01(options.nearReveal01 ?? 0.0);
    this.nearIntensity01 = start;
    this.nearTargetIntensity01 = start;
    this.externalTarget01 = 0.0;

    this.applyNearColorsWithPulse(this.nearIntensity01);
    (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

    // ----------------------------
    // BAND (new): true 3D shell driven by low/mid/high
    // ----------------------------
    const bandCount = Math.max(0, options.bandCount ?? 1337);
    const bandInnerRadius = Math.max(this.exclusionRadius, options.bandInnerRadius ?? 1300);
    const bandOuterRadius = Math.max(bandInnerRadius + 1, options.bandOuterRadius ?? 2600);
    const bandSize = Math.max(0.1, options.bandSize ?? 1.45);

    this.bandInnerRadius = bandInnerRadius;
    this.bandOuterRadius = bandOuterRadius;

    this.bandGeom = new THREE.BufferGeometry();

    this.bandPositions = this.makeShellPositions({
      count: bandCount,
      innerRadius: bandInnerRadius,
      outerRadius: bandOuterRadius,
    });
    this.bandGeom.setAttribute("position", new THREE.BufferAttribute(this.bandPositions, 3));

    this.bandColors = new Float32Array(bandCount * 3);
    this.bandGeom.setAttribute("color", new THREE.BufferAttribute(this.bandColors, 3));

    this.bandMat = new THREE.PointsMaterial({
      color: 0xffffed, // multiplier
      vertexColors: true,
      size: bandSize,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });

    this.bandPoints = new THREE.Points(this.bandGeom, this.bandMat);
    this.bandPoints.name = "Stars_BAND";
    scene.add(this.bandPoints);

    // Per-star caches
    this.bandRadii = new Float32Array(bandCount);
    this.bandVariance = new Float32Array(bandCount);
    this.bandPhase = new Float32Array(bandCount);

    this.bandWLow = new Float32Array(bandCount);
    this.bandWMid = new Float32Array(bandCount);
    this.bandWHigh = new Float32Array(bandCount);

    for (let i = 0; i < bandCount; i++) {
      const x = this.bandPositions[i * 3 + 0];
      const y = this.bandPositions[i * 3 + 1];
      const z = this.bandPositions[i * 3 + 2];
      const r = Math.sqrt(x * x + y * y + z * z);

      this.bandRadii[i] = r;

      // variance: BAND wants a little more “emotional” range
      this.bandVariance[i] = 0.72 + Math.random() * 0.40;

      // stable phase in radians [0..2pi)
      this.bandPhase[i] = Math.random() * Math.PI * 2;

      // cached band weights from radius (soft thirds with overlap)
      const t = clamp01((r - bandInnerRadius) / (bandOuterRadius - bandInnerRadius));
      const w = this.computeBandWeightsFromT(t);

      this.bandWLow[i] = w.low;
      this.bandWMid[i] = w.mid;
      this.bandWHigh[i] = w.high;
    }

    // Start BAND at true dark
    this.writeBandColors(0, 0, 0);
    (this.bandGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ----------------------------------------------------------
  // Public controls
  // ----------------------------------------------------------

  public setAudioDriven(enabled: boolean): void {
    this.audioDriven = Boolean(enabled);
  }

  public setAudioFrame(frame: AudioFrame): void {
    this.lastAudio = {
      energy: safe01(frame.energy, this.lastAudio.energy),
      low: safe01(frame.low, this.lastAudio.low),
      mid: safe01(frame.mid, this.lastAudio.mid),
      high: safe01(frame.high, this.lastAudio.high),
    };
  }

  public setAudioPlaying(isPlaying: boolean): void {
    this.isAudioPlaying = Boolean(isPlaying);
  }

  public setPulseMode(mode: PulseMode): void {
    this.pulseMode = mode;
  }

  /**
   * External brightness override (ritual progress, etc).
   * IMPORTANT: This is the “ritual lane”. It will auto-decay unless continually driven.
   */
  public setNearRevealTarget01(v: number): void {
    this.externalTarget01 = clamp01(v);
    this.externalTouchedThisFrame = true;
  }

  /** Baseline “rest” intensity. Recommend keeping this at 0. */
  public setNearBaselineReveal01(v: number): void {
    const vv = clamp01(v);
    this.nearIntensity01 = vv;
    this.nearTargetIntensity01 = vv;
  }

  public setColors(opts: { farColor?: number; nearColor?: number }): void {
    if (typeof opts.farColor === "number") this.farMat.color.setHex(opts.farColor);
    if (typeof opts.nearColor === "number") this.nearMat.color.setHex(opts.nearColor);
  }

  // ----------------------------
  // BAND public API (Harmony-ready)
  // ----------------------------

  public setBandColors(colors: { low: number; mid: number; high: number }): void {
    if (typeof colors.low === "number") this.bandColorLow = hexToRgb01(colors.low);
    if (typeof colors.mid === "number") this.bandColorMid = hexToRgb01(colors.mid);
    if (typeof colors.high === "number") this.bandColorHigh = hexToRgb01(colors.high);

    // Force a rewrite next update
    this.bandLastWriteKey = -1;
  }

  public setBandMixing(opts: Partial<{ overlap01: number; lowBias: number; midBias: number; highBias: number }>): void {
    if (typeof opts.overlap01 === "number") this.bandOverlap01 = clamp01(opts.overlap01);
    if (typeof opts.lowBias === "number") this.bandBiasLow = Math.max(0, opts.lowBias);
    if (typeof opts.midBias === "number") this.bandBiasMid = Math.max(0, opts.midBias);
    if (typeof opts.highBias === "number") this.bandBiasHigh = Math.max(0, opts.highBias);

    // Recompute cached weights (rare operation)
    this.recomputeBandWeights();
    this.bandLastWriteKey = -1;
  }

  public setBandGains(opts: Partial<{ master: number; low: number; mid: number; high: number }>): void {
    if (typeof opts.master === "number") this.bandGainMaster = Math.max(0, opts.master);
    if (typeof opts.low === "number") this.bandGainLow = Math.max(0, opts.low);
    if (typeof opts.mid === "number") this.bandGainMid = Math.max(0, opts.mid);
    if (typeof opts.high === "number") this.bandGainHigh = Math.max(0, opts.high);

    this.bandLastWriteKey = -1;
  }

  public triggerRadialPulse(
    opts?: Partial<{
      speed: number;
      width: number;
      strength: number;
      delaySec: number;

      afterRipple?: boolean;
      afterDelaySec?: number;
      afterStrengthMul?: number;
      afterWidthMul?: number;
      afterSpeedMul?: number;
    }>,
  ): void {
    const speed = Math.max(1, opts?.speed ?? 2200);
    const width = Math.max(1, opts?.width ?? 260);
    const strength = clamp01(opts?.strength ?? 0.8);
    const delay = Math.max(0, opts?.delaySec ?? 0);

    this.pulses.push({ t: 0, delay, speed, width, strength });
    if (this.pulses.length > this.maxPulses) this.pulses.shift();

    const afterOn = opts?.afterRipple ?? this.afterRippleEnabled;
    if (afterOn) {
      const afterDelay = Math.max(0, opts?.afterDelaySec ?? this.afterRippleDelaySec);
      const sMul = clamp01(opts?.afterStrengthMul ?? this.afterRippleStrengthMul);
      const wMul = Math.max(0.1, opts?.afterWidthMul ?? this.afterRippleWidthMul);
      const vMul = Math.max(0.1, opts?.afterSpeedMul ?? this.afterRippleSpeedMul);

      this.pulses.push({
        t: 0,
        delay: delay + afterDelay,
        speed: speed * vMul,
        width: width * wMul,
        strength: clamp01(strength * sMul),
      });
      if (this.pulses.length > this.maxPulses) this.pulses.shift();
    }
  }

  // ----------------------------------------------------------
  // Update
  // ----------------------------------------------------------
  public update(dt: number): void {
    const d = Math.max(0, dt);
    this.tSec += d;

    // pulses
    if (this.pulses.length > 0) {
      for (const p of this.pulses) p.t += d;

      this.pulses = this.pulses.filter((p) => {
        const age = p.t - p.delay;
        if (age <= 0) return true;
        return age * p.speed < this.nearMaxRadius + p.width;
      });
    }

    // auto-decay external lane unless driven this frame
    if (!this.externalTouchedThisFrame) {
      const k = 1 - Math.exp(-this.externalDecay * d);
      this.externalTarget01 = lerp(this.externalTarget01, 0.0, k);
    }
    this.externalTouchedThisFrame = false;

    // NEAR stars reactivity
    // audio target (continuous breathing)
    let audioTarget = 0.0;
    if (this.audioDriven && this.isAudioPlaying) {
      const e = clamp01(this.lastAudio.energy);

      // Gate: NEAR stays dark until intensity crosses the threshold.
      const g = gate01(e, this.nearEnergyOn, this.nearEnergyFeather);

      // Once gated on, map remaining range to 0..1 (so we don't waste headroom)
      const t = clamp01((e - this.nearEnergyOn) / Math.max(1e-6, 1 - this.nearEnergyOn));
      const shaped = Math.pow(t, Math.max(0.01, this.nearCurvePow));

      // Final: hard gate * shaped response
      audioTarget = clamp01(g * shaped);
    } else {
      // no audio playing => true darkness unless ritual lane is driving it
      audioTarget = 0.0;
    }

    const target = Math.max(audioTarget, this.externalTarget01);

    // ease intensity
    const t = 1 - Math.exp(-this.nearIntensityEase * d);
    const prevNear = this.nearIntensity01;
    this.nearIntensity01 = lerp(this.nearIntensity01, target, t);

    // ----------------------------------------------------------
    // IMPORTANT: ensure we "write to black" for NEAR
    // ----------------------------------------------------------
    const nearShouldBeDark = !this.isAudioPlaying && target <= 0.00001 && this.pulses.length === 0;

    const NEAR_SNAP_EPS = 0.003; // tune: 0.001..0.01
    if (nearShouldBeDark && this.nearIntensity01 < NEAR_SNAP_EPS) {
      this.nearIntensity01 = 0.0;

      // Force a final write that clears the GPU colors.
      this.applyNearColorsWithPulse(0.0);
      (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    } else {
      const nearFadingToDark = nearShouldBeDark && this.nearIntensity01 > 0.0;

      if (Math.abs(this.nearIntensity01 - prevNear) > 0.0 || this.pulses.length > 0 || nearFadingToDark) {
        this.applyNearColorsWithPulse(this.nearIntensity01);
        (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    // ----------------------------------------------------------
    // BAND update (low/mid/high, attack/release, shimmer)
    // ----------------------------------------------------------
    this.updateBand(d);
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.farPoints);
    scene.remove(this.nearPoints);
    scene.remove(this.bandPoints);

    this.farGeom.dispose();
    this.farMat.dispose();

    this.nearGeom.dispose();
    this.nearMat.dispose();

    this.bandGeom.dispose();
    this.bandMat.dispose();
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private makeShellPositions(params: { count: number; innerRadius: number; outerRadius: number }): Float32Array {
    const { count, innerRadius, outerRadius } = params;

    if (outerRadius <= 0) throw new Error(`[StarSystem] outerRadius must be > 0. Got ${outerRadius}.`);
    if (innerRadius < 0) throw new Error(`[StarSystem] innerRadius must be >= 0. Got ${innerRadius}.`);
    if (innerRadius >= outerRadius) {
      throw new Error(`[StarSystem] innerRadius (${innerRadius}) must be < outerRadius (${outerRadius}).`);
    }

    const positions = new Float32Array(count * 3);

    const r0c = innerRadius * innerRadius * innerRadius;
    const Rc = outerRadius * outerRadius * outerRadius;

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const phi = Math.acos(u);

      const tt = Math.random();
      const r = Math.cbrt(r0c + tt * (Rc - r0c));

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    return positions;
  }

  private getRadiusForPulse(i: number): number {
    return this.pulseMode === "planeXZ" ? this.nearRadiiXZ[i] : this.nearRadiiSphere[i];
  }

  private computePulseBoostForRadius(r: number): number {
    if (this.pulses.length === 0) return 0;

    let boost = 0;

    for (const p of this.pulses) {
      const age = p.t - p.delay;
      if (age <= 0) continue;

      const front = age * p.speed;

      // Signed distance: <0 = behind the front (wake), >0 = ahead
      const signed = r - front;

      const widthFront = Math.max(1, p.width * this.pulseFrontWidthMul);
      const widthBack = Math.max(1, p.width * this.pulseBackWidthMul);
      const w = signed >= 0 ? widthFront : widthBack;

      const d = Math.abs(signed);
      if (d > w) continue;

      const x = 1 - d / w;
      const band = smoothstep(0, 1, x);

      let ridge = 0;
      if (signed >= 0) {
        const ridgeW = Math.max(1, p.width * this.pulseFrontRidgeWidthMul);
        const rx = 1 - Math.min(1, d / ridgeW);
        ridge = smoothstep(0, 1, rx) * this.pulseFrontRidgeMul;
      }

      const b = p.strength * clamp01(band + ridge);
      boost = Math.max(boost, b);
    }

    return boost;
  }

  /**
   * Writes NEAR star colors for ALL stars (no “reveal by count”).
   * intensity01:
   *  - comes from audio breathing (when playing) and/or ritual external lane.
   */
  private applyNearColorsWithPulse(intensity01: number): void {
    const count = this.nearRadiiSphere.length;

    const hasPulse = this.pulses.length > 0;
    const dim = hasPulse ? this.pulseDimBase : 1.0;

    // Honor "true dark" before activation if desired
    const i01 = clamp01(intensity01);
    const baseBrightness = i01 <= 0 ? 0 : lerp(this.nearMinVisibleV, 1.0, i01);

    const baseScaled = baseBrightness * dim;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      const baseRaw = baseScaled * this.nearVariance[i];

      const r = this.getRadiusForPulse(i);
      const pulse = this.computePulseBoostForRadius(r);

      // Let pulse push above 1.0 for bloom/readability
      const added = pulse * (this.pulseMaxBoost - baseRaw);
      const v = clamp(baseRaw + added, 0, this.pulseMaxBoost);

      const tintAmt = clamp01((pulse - 0.02) / 0.40);

      const rr = lerp(v, v * this.pulseColorTint.r, tintAmt);
      const gg = lerp(v, v * this.pulseColorTint.g, tintAmt);
      const bb = lerp(v, v * this.pulseColorTint.b, tintAmt);

      this.nearColors[idx + 0] = rr;
      this.nearColors[idx + 1] = gg;
      this.nearColors[idx + 2] = bb;
    }
  }

  // ==========================================================
  // BAND internals
  // ==========================================================

  private recomputeBandWeights(): void {
    const count = this.bandRadii.length;
    const inner = this.bandInnerRadius;
    const outer = this.bandOuterRadius;
    const span = Math.max(1e-6, outer - inner);

    for (let i = 0; i < count; i++) {
      const t = clamp01((this.bandRadii[i] - inner) / span);
      const w = this.computeBandWeightsFromT(t);
      this.bandWLow[i] = w.low;
      this.bandWMid[i] = w.mid;
      this.bandWHigh[i] = w.high;
    }
  }

  /**
   * Map normalized radius t (0..1) to low/mid/high weights with soft overlap.
   * Inner tends LOW, middle tends MID, outer tends HIGH.
   */
  private computeBandWeightsFromT(t: number): { low: number; mid: number; high: number } {
    // overlap shaping
    // o in [0.15..0.95] to avoid degeneracy
    const o = lerp(0.18, 0.92, clamp01(this.bandOverlap01));

    // LOW: strong near 0, fades by mid
    const low = 1 - smoothstep(0.20 * o, 0.70 * o, t);

    // HIGH: grows toward 1, starts around mid-ish
    const high = smoothstep(1 - 0.70 * o, 1 - 0.20 * o, t);

    // MID: bell around 0.5 with width controlled by overlap
    const width = lerp(0.22, 0.48, o);
    const midRaw = 1 - Math.abs(t - 0.5) / Math.max(1e-6, width);
    const mid = smoothstep(0.0, 1.0, clamp01(midRaw));

    // Apply biases (future “mixing”)
    const a = Math.max(0, low * this.bandBiasLow);
    const b = Math.max(0, mid * this.bandBiasMid);
    const c = Math.max(0, high * this.bandBiasHigh);

    const n = normalize3(a, b, c);
    return { low: n.a, mid: n.b, high: n.c };
  }

  private bandGateCurve(v01: number, gate: number, curvePow: number): number {
    const g = clamp01(gate);
    const raw = smoothstep(g, 1.0, clamp01(v01));
    return clamp01(Math.pow(raw, Math.max(0.01, curvePow)));
  }

  private updateBand(dt: number): void {
    const playing = this.audioDriven && this.isAudioPlaying;

    // If no audio: target is zero, and we also handle hard snap to black.
    const lowTarget = playing ? this.bandGateCurve(this.lastAudio.low, this.bandGateLow, this.bandCurveLow) : 0.0;
    const midTarget = playing ? this.bandGateCurve(this.lastAudio.mid, this.bandGateMid, this.bandCurveMid) : 0.0;
    const highTarget = playing ? this.bandGateCurve(this.lastAudio.high, this.bandGateHigh, this.bandCurveHigh) : 0.0;

    const prevL = this.bandLevelLow;
    const prevM = this.bandLevelMid;
    const prevH = this.bandLevelHigh;

    this.bandLevelLow = smoothAR(this.bandLevelLow, lowTarget, this.bandAttackLow, this.bandReleaseLow, dt);
    this.bandLevelMid = smoothAR(this.bandLevelMid, midTarget, this.bandAttackMid, this.bandReleaseMid, dt);
    this.bandLevelHigh = smoothAR(this.bandLevelHigh, highTarget, this.bandAttackHigh, this.bandReleaseHigh, dt);

    // True darkness enforcement (write zeros and stop)
    const shouldBeDark =
      !this.isAudioPlaying &&
      this.bandLevelLow <= this.bandSnapEps &&
      this.bandLevelMid <= this.bandSnapEps &&
      this.bandLevelHigh <= this.bandSnapEps;

    if (shouldBeDark) {
      // Snap all to 0 and write once
      if (this.bandLevelLow !== 0 || this.bandLevelMid !== 0 || this.bandLevelHigh !== 0) {
        this.bandLevelLow = 0;
        this.bandLevelMid = 0;
        this.bandLevelHigh = 0;
      }

      // Only write if not already black (key caches)
      const key = 0;
      if (this.bandLastWriteKey !== key) {
        this.writeBandColors(0, 0, 0);
        (this.bandGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
        this.bandLastWriteKey = key;
      }

      return;
    }

    // Decide whether to write this frame:
    // - any level change
    // - or shimmer wants updates while highs are present
    const levelChanged =
      Math.abs(this.bandLevelLow - prevL) > 0.0 ||
      Math.abs(this.bandLevelMid - prevM) > 0.0 ||
      Math.abs(this.bandLevelHigh - prevH) > 0.0;

    const shimmerActive = this.bandLevelHigh > 0.02;

    // A small quantized “key” to reduce redundant writes when nearly stable
    const q = (x: number): number => Math.floor(clamp01(x) * 1000);
    const key = (q(this.bandLevelLow) << 20) ^ (q(this.bandLevelMid) << 10) ^ q(this.bandLevelHigh);

    if (!levelChanged && !shimmerActive && this.bandLastWriteKey === key) {
      return;
    }

    this.writeBandColors(this.bandLevelLow, this.bandLevelMid, this.bandLevelHigh);
    (this.bandGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    this.bandLastWriteKey = key;
  }

  private writeBandColors(levelLow: number, levelMid: number, levelHigh: number): void {
    const count = this.bandRadii.length;

    const l = clamp01(levelLow) * this.bandGainLow;
    const m = clamp01(levelMid) * this.bandGainMid;
    const h = clamp01(levelHigh) * this.bandGainHigh;

    const master = this.bandGainMaster;

    const shimmerAmp = this.bandHighShimmerAmt * clamp01(levelHigh);
    const shimmerW = Math.PI * 2 * this.bandHighShimmerHz; // rad/sec

    const cL = this.bandColorLow;
    const cM = this.bandColorMid;
    const cH = this.bandColorHigh;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      const wL = this.bandWLow[i];
      const wM = this.bandWMid[i];
      const wH = this.bandWHigh[i];

      // Weighted band energy at this star
      let e = l * wL + m * wM + h * wH;

      // Variance makes the field feel alive, not like a uniform LED panel
      e *= this.bandVariance[i];

      // High shimmer (subtle): only meaningful for stars with some high weight
      if (shimmerAmp > 0.0001 && wH > 0.02) {
        const s = Math.sin(this.tSec * shimmerW + this.bandPhase[i]);
        const shimmer = 1 + s * shimmerAmp * wH;
        e *= shimmer;
      }

      // Master gain, keep clamped to avoid absurd bloom spikes
      const v = clamp(e * master, 0, 2.25);

      // Tint by blending the 3 palette colors via weights
      const rr = v * (cL.r * wL + cM.r * wM + cH.r * wH);
      const gg = v * (cL.g * wL + cM.g * wM + cH.g * wH);
      const bb = v * (cL.b * wL + cM.b * wM + cH.b * wH);

      this.bandColors[idx + 0] = rr;
      this.bandColors[idx + 1] = gg;
      this.bandColors[idx + 2] = bb;
    }
  }
}
