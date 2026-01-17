// ============================================================
// THE STILL — P03
// ClockSystem.ts
// ------------------------------------------------------------
// Responsibilities:
//  - Render three concentric neon "starlight" rings for
//    Hours, Minutes, and Seconds.
//  - Each ring is a single comet-style trail orbiting the core:
//      * Bright "head" at the current time position
//      * Tail length is fixed (configurable via min/max tail settings)
//  - Driven by local time, independent of audio.
//
// Tail behavior (FINALIZED):
//  - Tail arc is fixed to a constant factor (0..1).
//  - This keeps the clock math anchored cleanly to a single reference,
//    with no external state or "presence" concept.
//
// Enhancements:
//  - Global + distance-based intensity scaling
//  - Optional audio-reactive boost hooks
//  - Thickness scaling APIs (global + per-ring)
//  - Color mode wiring for future rainbow / vinyl modes
//    (logic included but commented out as requested)
//  - Smooth hour movement (real clock behavior)
//  - Epsilon boundary tolerance to prevent dot popping
//
// Bloom notes:
//  - We tag these rings onto BLOOM_LAYER so a selective-bloom pipeline
//    can target them.
//  - ALSO: we allow intensity to exceed 1.0 (headroom) so bloom has
//    something bright to grab. (This does nothing harmful without bloom.)
// ============================================================

import * as THREE from "three";

// If/when you implement selective bloom in PostFX, use this same layer index there.
const BLOOM_LAYER = 1;

// Bloom needs bright pixels; allow headroom above 1.0 (in linear space).
// Keep this conservative to avoid “flashy” surprises.
const BLOOM_HEADROOM_MAX = 2.25;

// Fixed tail factor (0..1). Higher = longer comet tail.
const FIXED_TAIL_FACTOR = 0.85;

export type ClockColorMode = "classic" | "perRing" | "rainbow" | "vinyl";

export interface ClockSystemConfig {
  /** Conceptual base resolution for hours (12 by default). */
  pointsPerRing?: number;

  /**
   * Minimum tail factor (0..1).
   * This still defines the lower bound of tail arc inside RingPoints.
   */
  minTailLength?: number;

  /**
   * Maximum tail factor (0..1).
   * This still defines the upper bound of tail arc inside RingPoints.
   */
  maxTailLength?: number;
}

export class ClockSystem {
  private readonly root: THREE.Group;

  private readonly pointsPerRing: number;

  private readonly hourRing: RingPoints;
  private readonly minuteRing: RingPoints;
  private readonly secondRing: RingPoints;

  private readonly _tempColor = new THREE.Color();

  // Control knobs
  private colorMode: ClockColorMode = "classic";
  private globalIntensity = 1.0;
  private distanceFactor = 1.0;

  private audioLow = 0.0;
  private audioMid = 0.0;
  private audioHigh = 0.0;

  constructor(config: ClockSystemConfig = {}) {
    this.root = new THREE.Group();
    this.root.name = "ClockSystem";

    this.pointsPerRing = config.pointsPerRing ?? 12;

    const minTail = THREE.MathUtils.clamp(config.minTailLength ?? 0.31, 0.0, 1.0);
    const maxTail = THREE.MathUtils.clamp(config.maxTailLength ?? 0.97, 0.0, 1.0);

    const baseRadius = 10.0;
    const gap = 0.79;

    // Hour ring (12)
    this.hourRing = new RingPoints({
      radius: baseRadius + gap * 7.9,
      thickness: 0.70,
      points: this.pointsPerRing * 144,
      falloffFactor: 0.31,
      minTailLength: minTail,
      maxTailLength: maxTail,
      baseColor: new THREE.Color(0xd4af37),
    });
    this.root.add(this.hourRing.points);

    // Minute ring (60)
    this.minuteRing = new RingPoints({
      radius: baseRadius + gap * 3.1,
      thickness: 0.40,
      points: this.pointsPerRing * 144,
      falloffFactor: 0.31,
      minTailLength: minTail,
      maxTailLength: maxTail,
      baseColor: new THREE.Color(0xd4af37),
    });
    this.root.add(this.minuteRing.points);

    // Second ring (360)
    this.secondRing = new RingPoints({
      radius: baseRadius * 1.0,
      thickness: 0.20,
      points: this.pointsPerRing * 144,
      falloffFactor: 0.31,
      minTailLength: minTail,
      maxTailLength: maxTail,
      baseColor: new THREE.Color(0xd4af37),
    });
    this.root.add(this.secondRing.points);

    // Tag all rings for bloom targeting (future selective bloom pipeline)
    this.setBloomLayerEnabled(true);

    // Define True North for Rings (presentation transform)
    this.root.rotation.y = -Math.PI / 2;
  }

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public getHourColor(target?: THREE.Color): THREE.Color {
    const out = target ?? this._tempColor;
    return out.copy(this.hourRing.getBaseColor());
  }

  // ---------- Bloom tagging ----------

  /**
   * Enable/disable bloom layer membership for these rings.
   * NOTE:
   * - This only matters if your PostFX pipeline is doing selective bloom by layers.
   * - With your current single-pass UnrealBloomPass, bloom is global.
   */
  public setBloomLayerEnabled(enabled: boolean): void {
    const apply = (obj: THREE.Object3D): void => {
      obj.traverse((o) => {
        if (enabled) o.layers.enable(BLOOM_LAYER);
        else o.layers.disable(BLOOM_LAYER);
      });
    };

    apply(this.hourRing.points);
    apply(this.minuteRing.points);
    apply(this.secondRing.points);
  }

  // ---------- Control knobs ----------

  public setGlobalIntensity(value: number): void {
    this.globalIntensity = Math.max(0, value);
  }

  public setDistanceFactor(value: number): void {
    this.distanceFactor = Math.max(0, value);
  }

  public setAudioLevels(low: number, mid: number, high: number): void {
    this.audioLow = THREE.MathUtils.clamp(low, 0, 1);
    this.audioMid = THREE.MathUtils.clamp(mid, 0, 1);
    this.audioHigh = THREE.MathUtils.clamp(high, 0, 1);
  }

  public setColorMode(mode: ClockColorMode): void {
    this.colorMode = mode;
  }

  public setThicknessScale(scale: number): void {
    const s = Math.max(0.1, scale);
    this.hourRing.setThicknessScale(s);
    this.minuteRing.setThicknessScale(s);
    this.secondRing.setThicknessScale(s);
  }

  public setRingThicknessScales(hourScale: number, minuteScale: number, secondScale: number): void {
    this.hourRing.setThicknessScale(Math.max(0.1, hourScale));
    this.minuteRing.setThicknessScale(Math.max(0.1, minuteScale));
    this.secondRing.setThicknessScale(Math.max(0.1, secondScale));
  }

  public update(_dt: number): void {
    const now = new Date();

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();

    const tau = Math.PI * 2;

    // Smooth hour progress
    const hourProgress =
      ((hours % 12) + minutes / 60 + seconds / 3600 + ms / 3600000) / 12;

    const minuteProgress = (minutes + seconds / 60 + ms / 60000) / 60;
    const secondProgress = (seconds + ms / 1000) / 60;

    const hourAngle = hourProgress * tau;
    const minuteAngle = minuteProgress * tau;
    const secondAngle = secondProgress * tau;

    const baseIntensity = this.globalIntensity * this.distanceFactor;

    const hourBoost = 1 + this.audioLow * 0.6;
    const minuteBoost = 1 + this.audioMid * 0.6;
    const secondBoost = 1 + this.audioHigh * 0.6;

    const tail = FIXED_TAIL_FACTOR;

    this.hourRing.updateFill(hourAngle, baseIntensity * hourBoost, tail, this.colorMode);
    this.minuteRing.updateFill(minuteAngle, baseIntensity * minuteBoost, tail, this.colorMode);
    this.secondRing.updateFill(secondAngle, baseIntensity * secondBoost, tail, this.colorMode);
  }

  public dispose(): void {
    this.hourRing.dispose();
    this.minuteRing.dispose();
    this.secondRing.dispose();
  }
}

// ------------------------------------------------------------
// Internal helper: RingPoints
// ------------------------------------------------------------

interface RingPointsConfig {
  radius: number;
  thickness: number;
  points: number;
  falloffFactor: number;
  minTailLength: number;
  maxTailLength: number;
  baseColor: THREE.Color;
}

class RingPoints {
  public readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly baseColor: THREE.Color;

  private readonly angles: Float32Array;
  private readonly colors: Float32Array;

  private readonly falloffPower: number;
  private readonly minTailLengthFraction: number;
  private readonly maxTailLengthFraction: number;

  private readonly baseSize: number;
  private readonly tempColor = new THREE.Color();

  constructor(config: RingPointsConfig) {
    const { radius, thickness, points, falloffFactor, minTailLength, maxTailLength, baseColor } = config;

    this.geometry = new THREE.BufferGeometry();
    this.baseSize = thickness * 0.8;

    this.material = new THREE.PointsMaterial({
      size: this.baseSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Important for bright/bloomy neon: don’t let renderer tonemap this material down.
    // (No harm if you later change tone mapping strategies.)
    this.material.toneMapped = false;

    this.baseColor = baseColor.clone();

    const clampedFalloff = THREE.MathUtils.clamp(falloffFactor, 0, 1);
    this.falloffPower = THREE.MathUtils.lerp(1.2, 3.0, clampedFalloff);

    this.minTailLengthFraction = THREE.MathUtils.clamp(minTailLength, 0, 1);
    this.maxTailLengthFraction = THREE.MathUtils.clamp(maxTailLength, 0, 1);

    const positions = new Float32Array(points * 3);
    this.colors = new Float32Array(points * 3);
    this.angles = new Float32Array(points);

    for (let i = 0; i < points; i++) {
      const t = i / points;
      const angle = t * Math.PI * 2;

      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      const idx = i * 3;
      positions[idx] = x;
      positions[idx + 1] = 0;
      positions[idx + 2] = z;

      this.colors[idx] = 0;
      this.colors[idx + 1] = 0;
      this.colors[idx + 2] = 0;

      this.angles[i] = angle;
    }

    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "ClockRingPoints";
  }

  public getBaseColor(): THREE.Color {
    return this.baseColor;
  }

  public setThicknessScale(scale: number): void {
    this.material.size = this.baseSize * scale;
  }

  public updateFill(
    headAngle: number,
    intensityScale: number = 1,
    tailFactor: number = FIXED_TAIL_FACTOR,
    mode: ClockColorMode = "classic",
  ): void {
    const tau = Math.PI * 2;

    // Normalize headAngle to [0, TAU)
    let head = headAngle % tau;
    if (head < 0) head += tau;

    const tail = THREE.MathUtils.clamp(tailFactor, 0, 1);
    const safeIntensityScale = Math.max(0, intensityScale);

    // Tail arc purely based on fixed tail factor (single-comet model)
    const minArc = Math.max(this.minTailLengthFraction * tau, 1e-4);
    const maxArc = Math.max(this.maxTailLengthFraction * tau, 1e-4);
    const tailArc = THREE.MathUtils.lerp(minArc, maxArc, tail);

    const baseR = this.baseColor.r;
    const baseG = this.baseColor.g;
    const baseB = this.baseColor.b;

    const colors = this.colors;
    const angles = this.angles;
    const count = angles.length;

    const EPS = 1e-6;

    for (let i = 0; i < count; i++) {
      const angle = angles[i];

      // deltaBack = how far back from head this point is (0 at head)
      let deltaBack = head - angle;
      deltaBack = (deltaBack + tau) % tau;

      let intensity = 0;

      if (deltaBack >= 0 && deltaBack <= tailArc + EPS) {
        const t = 1 - deltaBack / tailArc;

        const TAIL_FLOOR = 0.031;
        const shaped = Math.pow(t, this.falloffPower);

        // This produces 0..1-ish, then we multiply by safeIntensityScale.
        intensity = TAIL_FLOOR + (1 - TAIL_FLOOR) * shaped;
      }

      // Allow >1 so bloom can catch it. Cap for safety.
      intensity *= safeIntensityScale;
      intensity = Math.min(intensity, BLOOM_HEADROOM_MAX);

      const idx = i * 3;
      colors[idx] = baseR * intensity;
      colors[idx + 1] = baseG * intensity;
      colors[idx + 2] = baseB * intensity;

      void mode;
    }

    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
