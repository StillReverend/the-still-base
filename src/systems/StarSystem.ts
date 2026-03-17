// ============================================================
// THE STILL — P03 (StarSystem: FAR + NEAR only)
// StarSystem.ts
// ------------------------------------------------------------
// NOW:
//  - FAR stars: static-ish, subtle
//  - NEAR stars: pool with brightness modulated by audio “intensity” (0..1)
//    + ritual external lane + shockwave pulse
//
// IMPORTANT ARCHITECTURE SHIFT (Mar 2026):
//  - BAND has been removed from StarSystem.
//  - Dynamic particle/star modes now belong to ParticleFX / FieldFX.
//  - StarSystem is now responsible only for "actual stars in the Still":
//      FAR, NEAR, and future true star groups.
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
};

type AudioFrame = {
  energy?: number;
  low?: number;
  mid?: number;
  high?: number;
};

type PulseMode = "sphere" | "planeXZ";

type RadialPulse = {
  t: number;
  delay: number;
  speed: number;
  width: number;
  strength: number;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clamp = (v: number, a: number, b: number): number =>
  Math.min(b, Math.max(a, v));
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
  private nearRadiiSphere: Float32Array;
  private nearRadiiXZ: Float32Array;

  // Stable per-star brightness variance
  private nearVariance: Float32Array;

  // State
  private readonly exclusionRadius: number;

  // Breathing field intensity (0..1)
  private nearIntensity01 = 0.0;
  private nearTargetIntensity01 = 0.0;
  private nearIntensityEase = 7.9;

  // External override lane (ritual), separate from audio
  private externalTarget01 = 0.0;
  private externalTouchedThisFrame = false;
  private externalDecay = 1.05;

  // Audio cache
  private isAudioPlaying = false;
  private lastAudio: Required<AudioFrame> = {
    energy: 0,
    low: 0,
    mid: 0,
    high: 0,
  };
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
  private nearEnergyOn = 0.50;
  private nearEnergyFeather = 0.10;
  private nearMinVisibleV = 0.0;
  private nearCurvePow = 1.0;

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
    const nearInnerRadius = Math.max(
      this.exclusionRadius,
      options.nearInnerRadius ?? 5000,
    );
    const nearOuterRadius = Math.max(
      nearInnerRadius + 1,
      options.nearOuterRadius ?? 10000,
    );
    const nearSize = Math.max(0.1, options.nearSize ?? 1.65);
    const nearBaseColor = options.nearBaseColor ?? 0xffffed;

    this.nearMaxRadius = nearOuterRadius;

    this.nearGeom = new THREE.BufferGeometry();

    this.nearPositions = this.makeShellPositions({
      count: nearCount,
      innerRadius: nearInnerRadius,
      outerRadius: nearOuterRadius,
    });

    this.nearGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(this.nearPositions, 3),
    );

    this.nearColors = new Float32Array(nearCount * 3);
    this.nearGeom.setAttribute(
      "color",
      new THREE.BufferAttribute(this.nearColors, 3),
    );

    this.nearMat = new THREE.PointsMaterial({
      color: nearBaseColor,
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

    const start = clamp01(options.nearReveal01 ?? 0.0);
    this.nearIntensity01 = start;
    this.nearTargetIntensity01 = start;
    this.externalTarget01 = 0.0;

    this.applyNearColorsWithPulse(this.nearIntensity01);
    (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate =
      true;
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
   * IMPORTANT: This is the ritual lane. It will auto-decay unless continually driven.
   */
  public setNearRevealTarget01(v: number): void {
    this.externalTarget01 = clamp01(v);
    this.externalTouchedThisFrame = true;
  }

  public setNearBaselineReveal01(v: number): void {
    const vv = clamp01(v);
    this.nearIntensity01 = vv;
    this.nearTargetIntensity01 = vv;
  }

  public setColors(opts: { farColor?: number; nearColor?: number }): void {
    if (typeof opts.farColor === "number") this.farMat.color.setHex(opts.farColor);
    if (typeof opts.nearColor === "number") this.nearMat.color.setHex(opts.nearColor);
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

    if (this.pulses.length > 0) {
      for (const p of this.pulses) p.t += d;

      this.pulses = this.pulses.filter((p) => {
        const age = p.t - p.delay;
        if (age <= 0) return true;
        return age * p.speed < this.nearMaxRadius + p.width;
      });
    }

    if (!this.externalTouchedThisFrame) {
      const k = 1 - Math.exp(-this.externalDecay * d);
      this.externalTarget01 = lerp(this.externalTarget01, 0.0, k);
    }
    this.externalTouchedThisFrame = false;

    let audioTarget = 0.0;
    if (this.audioDriven && this.isAudioPlaying) {
      const e = clamp01(this.lastAudio.energy);

      const g = gate01(e, this.nearEnergyOn, this.nearEnergyFeather);
      const t = clamp01(
        (e - this.nearEnergyOn) / Math.max(1e-6, 1 - this.nearEnergyOn),
      );
      const shaped = Math.pow(t, Math.max(0.01, this.nearCurvePow));

      audioTarget = clamp01(g * shaped);
    } else {
      audioTarget = 0.0;
    }

    const target = Math.max(audioTarget, this.externalTarget01);

    const t = 1 - Math.exp(-this.nearIntensityEase * d);
    const prevNear = this.nearIntensity01;
    this.nearIntensity01 = lerp(this.nearIntensity01, target, t);

    const nearShouldBeDark =
      !this.isAudioPlaying && target <= 0.00001 && this.pulses.length === 0;

    const nearSnapEps = 0.003;
    if (nearShouldBeDark && this.nearIntensity01 < nearSnapEps) {
      this.nearIntensity01 = 0.0;
      this.applyNearColorsWithPulse(0.0);
      (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate =
        true;
    } else {
      const nearFadingToDark = nearShouldBeDark && this.nearIntensity01 > 0.0;

      if (
        Math.abs(this.nearIntensity01 - prevNear) > 0.0 ||
        this.pulses.length > 0 ||
        nearFadingToDark
      ) {
        this.applyNearColorsWithPulse(this.nearIntensity01);
        (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate =
          true;
      }
    }
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.farPoints);
    scene.remove(this.nearPoints);

    this.farGeom.dispose();
    this.farMat.dispose();

    this.nearGeom.dispose();
    this.nearMat.dispose();
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private makeShellPositions(params: {
    count: number;
    innerRadius: number;
    outerRadius: number;
  }): Float32Array {
    const { count, innerRadius, outerRadius } = params;

    if (outerRadius <= 0) {
      throw new Error(
        `[StarSystem] outerRadius must be > 0. Got ${outerRadius}.`,
      );
    }
    if (innerRadius < 0) {
      throw new Error(
        `[StarSystem] innerRadius must be >= 0. Got ${innerRadius}.`,
      );
    }
    if (innerRadius >= outerRadius) {
      throw new Error(
        `[StarSystem] innerRadius (${innerRadius}) must be < outerRadius (${outerRadius}).`,
      );
    }

    const positions = new Float32Array(count * 3);

    const r0c = innerRadius * innerRadius * innerRadius;
    const rc = outerRadius * outerRadius * outerRadius;

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const phi = Math.acos(u);

      const tt = Math.random();
      const r = Math.cbrt(r0c + tt * (rc - r0c));

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    return positions;
  }

  private getRadiusForPulse(i: number): number {
    return this.pulseMode === "planeXZ"
      ? this.nearRadiiXZ[i]
      : this.nearRadiiSphere[i];
  }

  private computePulseBoostForRadius(r: number): number {
    if (this.pulses.length === 0) return 0;

    let boost = 0;

    for (const p of this.pulses) {
      const age = p.t - p.delay;
      if (age <= 0) continue;

      const front = age * p.speed;
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

  private applyNearColorsWithPulse(intensity01: number): void {
    const count = this.nearRadiiSphere.length;

    const hasPulse = this.pulses.length > 0;
    const dim = hasPulse ? this.pulseDimBase : 1.0;

    const i01 = clamp01(intensity01);
    const baseBrightness = i01 <= 0 ? 0 : lerp(this.nearMinVisibleV, 1.0, i01);
    const baseScaled = baseBrightness * dim;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      const baseRaw = baseScaled * this.nearVariance[i];

      const r = this.getRadiusForPulse(i);
      const pulse = this.computePulseBoostForRadius(r);

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
}