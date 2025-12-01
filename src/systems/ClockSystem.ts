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
// Notes:
//  - Uses THREE.Points with per-vertex colors (no shaders yet).
//  - Later phases can:
//      * add bloom/post-processing
//      * add color modes (perRing / rainbow / vinyl)
//      * hook into audio for ripple effects.
// ============================================================

import * as THREE from "three";

export interface ClockSystemConfig {
  /** Number of points per ring (higher = smoother arc). */
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

  constructor(config: ClockSystemConfig = {}) {
    this.root = new THREE.Group();
    this.root.name = "ClockSystem";

    this.pointsPerRing = config.pointsPerRing ?? 512;
    this.tailLength = THREE.MathUtils.clamp(
      config.tailLength ?? 0.25,
      0.0,
      1.0,
    );

    // Base radii and thickness values; tweak as needed
    const baseRadius = 2.5;
    const gap = 0.35;

    // Hour ring (thickest, closest to core)
    this.hourRing = new RingPoints({
      radius: baseRadius,
      thickness: 0.20,
      points: this.pointsPerRing,
      // Use tailLength to control falloff softness
      falloffFactor: this.tailLength * 0.6,
      baseColor: new THREE.Color(0x1a1a40),
    });
    this.root.add(this.hourRing.points);

    // Minute ring (medium thickness)
    this.minuteRing = new RingPoints({
      radius: baseRadius + gap * 1,
      thickness: 0.15,
      points: this.pointsPerRing,
      falloffFactor: this.tailLength,
      baseColor: new THREE.Color(0x1a1a40),
    });
    this.root.add(this.minuteRing.points);

    // Second ring (thinnest, largest radius)
    this.secondRing = new RingPoints({
      radius: baseRadius + gap * 3,
      thickness: 0.10,
      points: this.pointsPerRing,
      falloffFactor: this.tailLength * 1.4,
      baseColor: new THREE.Color(0x1a1a40),
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

    // Update each ring with:
    //  - headAngle = current time position
    //  - fillFraction = how far around the circle to fill from "12"
    this.hourRing.updateFill(hourAngle, hourProgress);
    this.minuteRing.updateFill(minuteAngle, minuteProgress);
    this.secondRing.updateFill(secondAngle, secondProgress);
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

  constructor(config: RingPointsConfig) {
    const {
      radius,
      thickness,
      points,
      falloffFactor,
      baseColor,
    } = config;

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.PointsMaterial({
      size: thickness * 0.8,
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
   * Fill an arc from "12 o'clock" up to headAngle, with the
   * brightest point at headAngle and a gradient fading back
   * toward the oldest part of the arc near 12.
   *
   * @param headAngle    current time position in radians (0..2π)
   * @param fillFraction how much of the circle is filled (0..1)
   */
  public updateFill(
    headAngle: number,
    fillFraction: number,
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

    for (let i = 0; i < count; i++) {
      const angle = angles[i];

      // We measure "behind the head" along the circle.
      // delta = how far back from head this point lies, along the
      // completed arc. 0 at head, increasing toward 12.
      let delta = head - angle;
      delta = (delta + tau) % tau; // normalize to [0, 2π)

      let intensity = 0;

      if (delta >= 0 && delta <= fillArc) {
        // 0 at the oldest part, 1 at head
        const t = 1 - delta / fillArc;
        intensity = Math.pow(t, this.falloffPower);
      }

      const idx = i * 3;
      colors[idx] = baseR * intensity;
      colors[idx + 1] = baseG * intensity;
      colors[idx + 2] = baseB * intensity;
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
