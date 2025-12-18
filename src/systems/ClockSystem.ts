// ============================================================
// THE STILL — P03
// ClockSystem.ts
// ------------------------------------------------------------
// Responsibilities:
//  - Render three concentric neon "starlight" rings for
//    Hours, Minutes, and Seconds.
//  - Each ring is a comet-style trail orbiting the core:
//      * Bright "head" at the current time position
//      * Fixed-length tail behind it, controlled by tailLength
//  - Driven by local time, independent of audio.
//
// Tail behavior:
//  - tailLength (0..1) controls how much of the circle the
//    comet tail covers (as a fraction of 2π).
//  - The tail does NOT reset at 12 o'clock.
//  - Head keeps time, tail stays a consistent orbiting length.
//
// Enhancements:
//  - Global + distance-based intensity scaling
//  - Optional audio-reactive boost hooks
//  - Thickness scaling APIs (global + per-ring)
//  - Color mode wiring for future rainbow / vinyl modes
//    (logic included but commented out as requested)
//  - Smooth hour movement (real clock behavior)
//  - Epsilon boundary tolerance to prevent dot popping
// ============================================================

import * as THREE from "three";

export type ClockColorMode = "classic" | "perRing" | "rainbow" | "vinyl";

export interface ClockSystemConfig {
  /** Conceptual base resolution for hours (12 by default). */
  pointsPerRing?: number;
  /**
   * Global tail factor (0..1).
   * - Controls gradient "sharpness"
   * - Controls the comet tail length as a fraction of the circle.
   *
   * Examples:
   *  tailLength = 0.25 -> tail spans 25% of orbit
   *  tailLength = 0.5  -> tail spans half the circle
   *  tailLength = 1.0  -> tail spans the full circle
   */
  tailLength?: number;
}

export class ClockSystem {
  private readonly root: THREE.Group;

  private readonly pointsPerRing: number;
  private readonly tailLength: number;

  private readonly hourRing: RingPoints;
  private readonly minuteRing: RingPoints;
  private readonly secondRing: RingPoints;

  private readonly _tempColor = new THREE.Color();

  // Control knobs (all default to neutral behavior)
  private colorMode: ClockColorMode = "classic";
  private globalIntensity = 1.0;
  private distanceFactor = 1.0;

  private audioLow = 0.0;
  private audioMid = 0.0;
  private audioHigh = 0.0;

  constructor(config: ClockSystemConfig = {}) {
    this.root = new THREE.Group();
    this.root.name = "ClockSystem";

    // Conceptual footing: "hour resolution".
    //  - hours:   12 conceptual slots
    //  - minutes: 60 conceptual slots
    //  - seconds: 360 conceptual slots
    this.pointsPerRing = config.pointsPerRing ?? 12;

    // Drives both gradient shaping & comet tail length.
    this.tailLength = THREE.MathUtils.clamp(config.tailLength ?? 0.25, 0.0, 1.0);

    // Base radii and thickness values; tweak as needed
    const baseRadius = 3.1;
    const gap = 0.6;

    // Hour ring (thickest)
    this.hourRing = new RingPoints({
      radius: baseRadius + gap * 7,
      thickness: 0.1,
      points: this.pointsPerRing, // 12
      falloffFactor: this.tailLength * 2.0,
      tailLength: this.tailLength * 1.7,
      baseColor: new THREE.Color(0xd4af37),
    });
    this.root.add(this.hourRing.points);

    // Minute ring (60)
    this.minuteRing = new RingPoints({
      radius: baseRadius + gap * 2.5,
      thickness: 0.15,
      points: this.pointsPerRing * 5, // 12 * 5 = 60
      falloffFactor: this.tailLength,
      tailLength: this.tailLength,
      baseColor: new THREE.Color(0x7fd0ff),
    });
    this.root.add(this.minuteRing.points);

    // Second ring (360)
    this.secondRing = new RingPoints({
      radius: baseRadius,
      thickness: 0.2,
      points: this.pointsPerRing * 30, // 12 * 30 = 360
      falloffFactor: this.tailLength * 1.4,
      tailLength: this.tailLength * 2.0,
      baseColor: new THREE.Color(0xff4f9a),
    });
    this.root.add(this.secondRing.points);
  }

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public getHourColor(target?: THREE.Color): THREE.Color {
    const out = target ?? this._tempColor;
    return out.copy(this.hourRing.getBaseColor());
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

    // ✅ C-1: Smooth hour progress (real clock behavior)
    // This removes the “snap” at the top of the hour.
    const hourProgress =
      ((hours % 12) + minutes / 60 + seconds / 3600 + ms / 3600000) / 12;

    // Smooth minutes + seconds (already “vibey”)
    const minuteProgress = (minutes + seconds / 60 + ms / 60000) / 60;
    const secondProgress = (seconds + ms / 1000) / 60;

    const hourAngle = hourProgress * tau;
    const minuteAngle = minuteProgress * tau;
    const secondAngle = secondProgress * tau;

    const baseIntensity = this.globalIntensity * this.distanceFactor;

    const hourBoost = 1 + this.audioLow * 0.6;
    const minuteBoost = 1 + this.audioMid * 0.6;
    const secondBoost = 1 + this.audioHigh * 0.6;

    this.hourRing.updateFill(hourAngle, hourProgress, baseIntensity * hourBoost, this.colorMode);
    this.minuteRing.updateFill(minuteAngle, minuteProgress, baseIntensity * minuteBoost, this.colorMode);
    this.secondRing.updateFill(secondAngle, secondProgress, baseIntensity * secondBoost, this.colorMode);
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
  tailLength: number;
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
  private readonly tailLengthFraction: number;

  private readonly baseSize: number;
  private readonly tempColor = new THREE.Color();

  constructor(config: RingPointsConfig) {
    const { radius, thickness, points, falloffFactor, tailLength, baseColor } = config;

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

    this.baseColor = baseColor.clone();

    // Map falloffFactor (0..1) to a 1.2–3.0 gamma for the gradient.
    const clampedFalloff = THREE.MathUtils.clamp(falloffFactor, 0, 1);
    this.falloffPower = THREE.MathUtils.lerp(1.2, 3.0, clampedFalloff);

    // Tail length as a fraction of the full circle (0..1).
    this.tailLengthFraction = THREE.MathUtils.clamp(tailLength, 0, 1);

    const positions = new Float32Array(points * 3);
    this.colors = new Float32Array(points * 3);
    this.angles = new Float32Array(points);

    for (let i = 0; i < points; i++) {
      const t = i / points;

      // 0 radians corresponds to +X. That’s OK because all rings share it,
      // so "true north" is consistent across rings. We can rotate the whole
      // ClockSystem group later if you want 12 to be +Z, etc.
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
    fillFraction: number, // currently unused for tail length
    intensityScale: number = 1,
    mode: ClockColorMode = "classic",
  ): void {
    const tau = Math.PI * 2;

    const tailArc = Math.max(this.tailLengthFraction * tau, 1e-4);

    let head = headAngle % tau;
    if (head < 0) head += tau;

    const baseR = this.baseColor.r;
    const baseG = this.baseColor.g;
    const baseB = this.baseColor.b;

    const colors = this.colors;
    const angles = this.angles;
    const count = angles.length;

    const safeIntensityScale = Math.max(0, intensityScale);

    // ✅ C-2: Epsilon to prevent boundary “dot popping”
    const EPS = 1e-6;

    for (let i = 0; i < count; i++) {
      const angle = angles[i];

      let delta = head - angle;
      delta = (delta + tau) % tau;

      let intensity = 0;

      if (delta >= 0 && delta <= tailArc + EPS) {
        const t = 1 - delta / tailArc;

        // Tail intensity floor so the oldest dots (e.g. 12/1 on hour ring)
        // don’t fade to invisibility.
        const TAIL_FLOOR = 0.14; // try 0.08–0.22

        const shaped = Math.pow(t, this.falloffPower);
        intensity = TAIL_FLOOR + (1 - TAIL_FLOOR) * shaped;
      }

      intensity *= safeIntensityScale;
      if (intensity > 1) intensity = 1;

      const idx = i * 3;

      colors[idx] = baseR * intensity;
      colors[idx + 1] = baseG * intensity;
      colors[idx + 2] = baseB * intensity;

      // --- Rainbow / Vinyl modes (EXPERIMENTAL, COMMENTED OUT) ---
      //
      // if (mode === "rainbow" || mode === "vinyl") {
      //   let hue = angle / tau;
      //   if (mode === "vinyl") {
      //     hue += 0.25;
      //     hue %= 1.0;
      //   }
      //   this.tempColor.setHSL(hue, 0.7, 0.5);
      //   colors[idx] = this.tempColor.r * intensity;
      //   colors[idx + 1] = this.tempColor.g * intensity;
      //   colors[idx + 2] = this.tempColor.b * intensity;
      // }
    }

    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
