// ============================================================
// THE STILL — P03
// ClockSystem.ts
// ------------------------------------------------------------
// Responsibilities:
//  - Render three concentric neon "starlight" rings for
//    Hours, Minutes, and Seconds.
//  - Each ring is a filled arc from "12 o'clock" up to the
//    current time, with the hottest point at the current
//    time position and a gradient fading back toward 12.
//  - Driven by local time, independent of audio.
//
// Enhancements in this version:
//  - Global + distance-based intensity scaling
//  - Optional audio-reactive boost hooks
//  - Thickness scaling APIs (global + per-ring)
//  - Color mode wiring for future rainbow / vinyl modes
//    (logic included but commented out as requested)
//  - Baseline tail intensity so 12 o'clock never fully vanishes
// ============================================================

import * as THREE from "three";

export type ClockColorMode = "classic" | "perRing" | "rainbow" | "vinyl";

export interface ClockSystemConfig {
  /** Number of points for the base hour ring. */
  pointsPerRing?: number;
  /** Global tail shaping factor (0..1) used to tweak falloff. */
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

  // New control knobs (all default to neutral behavior)
  private colorMode: ClockColorMode = "classic";
  private globalIntensity = 1.0;
  private distanceFactor = 1.0;

  private audioLow = 0.0;
  private audioMid = 0.0;
  private audioHigh = 0.0;

  constructor(config: ClockSystemConfig = {}) {
    this.root = new THREE.Group();
    this.root.name = "ClockSystem";

    // Base footing: think of this as "hour resolution".
    // H: pointsPerRing (12)   -> one per hour
    // M: pointsPerRing * 5    -> 60 slots
    // S: pointsPerRing * 30   -> 360 slots (1° per point)
    this.pointsPerRing = config.pointsPerRing ?? 12;

    this.tailLength = THREE.MathUtils.clamp(
      config.tailLength ?? 0.25,
      0.0,
      1.0,
    );

    // Base radii and thickness values; tweak as needed
    const baseRadius = 3.1;
    const gap = 0.6;

    // Hour ring (thickest, closest to core)
    this.hourRing = new RingPoints({
      radius: baseRadius + gap,
      thickness: 0.2,
      points: this.pointsPerRing,
      falloffFactor: this.tailLength * 0.6,
      baseColor: new THREE.Color(0xd4af37),
    });
    this.root.add(this.hourRing.points);

    // Minute ring (medium thickness)
    this.minuteRing = new RingPoints({
      radius: baseRadius + gap * 2,
      thickness: 0.16,
      points: this.pointsPerRing * 5,
      falloffFactor: this.tailLength,
      baseColor: new THREE.Color(0x7fd0ff),
    });
    this.root.add(this.minuteRing.points);

    // Second ring (thinnest, largest radius)
    this.secondRing = new RingPoints({
      radius: baseRadius + gap * 3,
      thickness: 0.12,
      points: this.pointsPerRing * 30,
      falloffFactor: this.tailLength * 1.4,
      baseColor: new THREE.Color(0xff4f9a),
    });
    this.root.add(this.secondRing.points);
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  /**
   * Returns the base color of the hour ring.
   * Uses an internal temp color if no target is provided.
   */
  public getHourColor(target?: THREE.Color): THREE.Color {
    const out = target ?? this._tempColor;
    return out.copy(this.hourRing.getBaseColor());
  }

  // ---------- New knobs ----------

  /**
   * Global brightness multiplier (0..N).
   * 1 = default, <1 = dimmer, >1 = hotter rings.
   */
  public setGlobalIntensity(value: number): void {
    this.globalIntensity = Math.max(0, value);
  }

  /**
   * Distance-based intensity control (0..N).
   * Idea: camera or core can set this based on distance.
   */
  public setDistanceFactor(value: number): void {
    this.distanceFactor = Math.max(0, value);
  }

  /**
   * Set current audio levels (0..1 ideally).
   * These are optional; if never called, rings behave as before.
   *
   * low  -> mostly affects hour ring
   * mid  -> mostly affects minute ring
   * high -> mostly affects second ring
   */
  public setAudioLevels(low: number, mid: number, high: number): void {
    this.audioLow = THREE.MathUtils.clamp(low, 0, 1);
    this.audioMid = THREE.MathUtils.clamp(mid, 0, 1);
    this.audioHigh = THREE.MathUtils.clamp(high, 0, 1);
  }

  /**
   * Switch between color modes.
   * For now, only "classic" is active; rainbow/vinyl logic
   * is stubbed out in RingPoints and commented as requested.
   */
  public setColorMode(mode: ClockColorMode): void {
    this.colorMode = mode;
  }

  /**
   * Uniform thickness scaling for all rings.
   * 1 = default current look, 2 = twice as thick, etc.
   */
  public setThicknessScale(scale: number): void {
    const s = Math.max(0.1, scale);
    this.hourRing.setThicknessScale(s);
    this.minuteRing.setThicknessScale(s);
    this.secondRing.setThicknessScale(s);
  }

  /**
   * Per-ring thickness scaling (H, M, S).
   */
  public setRingThicknessScales(
    hourScale: number,
    minuteScale: number,
    secondScale: number,
  ): void {
    this.hourRing.setThicknessScale(Math.max(0.1, hourScale));
    this.minuteRing.setThicknessScale(Math.max(0.1, minuteScale));
    this.secondRing.setThicknessScale(Math.max(0.1, secondScale));
  }

  /**
   * Called every frame.
   * Uses the current local time to position the "hot" point for
   * each ring and fills an arc from 12 o'clock up to that point.
   */
  public update(_dt: number): void {
    const now = new Date();

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();

    // Normalized elapsed fractions (0..1) for each ring.
    // Hours: 12-hour clock, anchored strictly to the hour number
    // to make reading easier (3:30 still shows the head at 3).
    const hour12 = hours % 12;
    const hourProgress = hour12 / 12;

    // Minutes and seconds get smooth motion for vibe.
    const minuteProgress =
      (minutes + seconds / 60 + ms / 60000) / 60;

    const secondProgress =
      (seconds + ms / 1000) / 60;

    const tau = Math.PI * 2;

    // Convert these to angles.
    const hourAngle = hourProgress * tau;
    const minuteAngle = minuteProgress * tau;
    const secondAngle = secondProgress * tau;

    // Intensity baseline (global + distance).
    const baseIntensity =
      this.globalIntensity * this.distanceFactor;

    // Audio boosts (subtle by design).
    const hourBoost = 1 + this.audioLow * 0.6;
    const minuteBoost = 1 + this.audioMid * 0.6;
    const secondBoost = 1 + this.audioHigh * 0.6;

    this.hourRing.updateFill(
      hourAngle,
      hourProgress,
      baseIntensity * hourBoost,
      this.colorMode,
    );

    this.minuteRing.updateFill(
      minuteAngle,
      minuteProgress,
      baseIntensity * minuteBoost,
      this.colorMode,
    );

    this.secondRing.updateFill(
      secondAngle,
      secondProgress,
      baseIntensity * secondBoost,
      this.colorMode,
    );
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
  /** 0..1 shaping factor for how soft the gradient falloff is. */
  falloffFactor: number;
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

  private readonly baseSize: number;
  private readonly tempColor = new THREE.Color();

  constructor(config: RingPointsConfig) {
    const {
      radius,
      thickness,
      points,
      falloffFactor,
      baseColor,
    } = config;

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

    // Map falloffFactor (≈0..1) to a 1.2–3.0 gamma for the gradient.
    // Lower value = softer falloff, higher = sharper head.
    const clamped = THREE.MathUtils.clamp(falloffFactor, 0, 1);
    this.falloffPower = THREE.MathUtils.lerp(1.2, 3.0, clamped);

    const positions = new Float32Array(points * 3);
    this.colors = new Float32Array(points * 3);
    this.angles = new Float32Array(points);

    for (let i = 0; i < points; i++) {
      const t = i / points;
      const angle = t * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = 0;

      const idx = i * 3;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;

      // Start invisible; updateFill will paint the arc.
      this.colors[idx] = 0;
      this.colors[idx + 1] = 0;
      this.colors[idx + 2] = 0;

      this.angles[i] = angle;
    }

    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "ClockRingPoints";
  }

  public getBaseColor(): THREE.Color {
    return this.baseColor;
  }

  /**
   * Uniform per-ring thickness scaling.
   */
  public setThicknessScale(scale: number): void {
    this.material.size = this.baseSize * scale;
  }

  /**
   * Fill an arc from "12 o'clock" up to headAngle, with the
   * brightest point at headAngle and a gradient fading back
   * toward the oldest part of the arc near 12.
   *
   * @param headAngle      current time position in radians (0..2π)
   * @param fillFraction   how much of the circle is filled (0..1)
   * @param intensityScale global+distance+audio multiplier
   * @param mode           color mode (classic / perRing / rainbow / vinyl)
   */
  public updateFill(
    headAngle: number,
    fillFraction: number,
    intensityScale: number = 1,
    mode: ClockColorMode = "classic",
  ): void {
    const tau = Math.PI * 2;
    const clampedFill = THREE.MathUtils.clamp(fillFraction, 0, 1);

    // Arc length from "12" to head along the direction of motion.
    const fillArc = Math.max(clampedFill * tau, 1e-4);

    // Normalize headAngle to [0, 2π)
    let head = headAngle % tau;
    if (head < 0) head += tau;

    const baseR = this.baseColor.r;
    const baseG = this.baseColor.g;
    const baseB = this.baseColor.b;

    const colors = this.colors;
    const angles = this.angles;
    const count = angles.length;

    const safeIntensityScale = Math.max(0, intensityScale);

    // Baseline intensity so that any point within the arc
    // never fully disappears (helps keep 12 o'clock visible).
    const minTailIntensity = 0.15; // tweak 0.1–0.25 to taste

    for (let i = 0; i < count; i++) {
      const angle = angles[i];

      // Measure "behind the head" along the circle:
      // delta = how far back from head this point lies along
      // the completed arc. 0 at head, increasing toward 12.
      let delta = head - angle;
      delta = (delta + tau) % tau; // normalize to [0, 2π)

      let intensity = 0;

      if (delta >= 0 && delta <= fillArc) {
        // 0 at the oldest part, 1 at head
        const t = 1 - delta / fillArc;

        // Shape the head with falloffPower, but keep a floor
        // along the arc so the start (near 12) never fully vanishes.
        const shaped = Math.pow(t, this.falloffPower);
        intensity =
          minTailIntensity +
          (1 - minTailIntensity) * shaped;
      }

      intensity *= safeIntensityScale;
      if (intensity > 1) intensity = 1;

      const idx = i * 3;

      // --- Classic / per-ring color mode (ACTIVE) ---
      // We always use baseColor for now to preserve current look.
      colors[idx] = baseR * intensity;
      colors[idx + 1] = baseG * intensity;
      colors[idx + 2] = baseB * intensity;

      // --- Rainbow / Vinyl modes (EXPERIMENTAL, COMMENTED OUT) ---
      //
      // Uncomment and adapt this block when you're ready to
      // preview rainbow / vinyl behaviors:
      //
      // if (mode === "rainbow" || mode === "vinyl") {
      //   // Rainbow: hue based on angle around the circle.
      //   // Vinyl: you could add an offset or quantization here.
      //   let hue = angle / tau; // 0..1 around the circle
      //
      //   if (mode === "vinyl") {
      //     // Example vinyl tweak: rotate hue and add subtle banding.
      //     hue += 0.25; // rotate palette
      //     hue %= 1.0;
      //   }
      //
      //   this.tempColor.setHSL(hue, 0.7, 0.5);
      //
      //   colors[idx] = this.tempColor.r * intensity;
      //   colors[idx + 1] = this.tempColor.g * intensity;
      //   colors[idx + 2] = this.tempColor.b * intensity;
      // } else {
      //   // Classic mode: per-ring baseColor
      //   colors[idx] = baseR * intensity;
      //   colors[idx + 1] = baseG * intensity;
      //   colors[idx + 2] = baseB * intensity;
      // }
    }

    (
      this.geometry.getAttribute("color") as THREE.BufferAttribute
    ).needsUpdate = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
