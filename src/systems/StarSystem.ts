// ============================================================
// THE STILL — P03 (StarSystem v0)
// StarSystem.ts
// ------------------------------------------------------------
// Goals (v0):
//  - FAR stars: sparse, mostly static, non-audio (or subtle), customizable later
//  - NEAR stars: dense pool, reveal tiers (1/3 → 2/3 → 3/3), audio + ritual driven
//  - Persistent occlusion zone around Core (no stars inside)
//
// Design:
//  - Two THREE.Points clouds (FAR + NEAR)
//  - NEAR uses per-vertex alpha (via vertexColors) so we can "reveal" a fraction
//    without reallocating geometry.
//  - v0 exposes simple control methods. Harmony will later orchestrate them.
// ============================================================

import * as THREE from "three";

type StarSystemOptions = {
  // Overall
  exclusionRadius?: number; // inner "no-star" radius around the core

  // FAR stars (sparse)
  farCount?: number;
  farRadius?: number; // outer radius of far distribution
  farSize?: number;
  farColor?: number;

  // NEAR stars (dense pool, revealed dynamically)
  nearCount?: number;
  nearInnerRadius?: number;
  nearOuterRadius?: number;
  nearSize?: number;
  nearBaseColor?: number;

  // Reveal behavior
  nearReveal01?: number; // initial reveal fraction 0..1 (default 0.33)
};

type AudioFrame = {
  energy?: number;
  low?: number;
  mid?: number;
  high?: number;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const safe01 = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return clamp01(n);
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

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

  // State
  private readonly exclusionRadius: number;

  private nearReveal01 = 0.33; // baseline reveal fraction
  private nearTargetReveal01 = 0.33; // driven by ritual/audio mapping
  private nearRevealEase = 6.0; // smoothing speed

  // Audio cache (optional mapping)
  private lastAudio: Required<AudioFrame> = { energy: 0, low: 0, mid: 0, high: 0 };
  private audioDriven = true;

  // A seeded ordering for reveal so stars "appear" consistently
  private nearOrder: Uint32Array;

  constructor(scene: THREE.Scene, options: StarSystemOptions = {}) {
    this.exclusionRadius = Math.max(0, options.exclusionRadius ?? 0);

    // ----------------------------
    // FAR (sparse)
    // ----------------------------
    const farCount = Math.max(0, options.farCount ?? 250);
    const farRadius = Math.max(1, options.farRadius ?? 6500);
    const farSize = Math.max(0.1, options.farSize ?? 1.25);
    const farColor = options.farColor ?? 0x9fb8ff;

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
      opacity: 0.75,
      depthWrite: false,
    });

    this.farPoints = new THREE.Points(this.farGeom, this.farMat);
    this.farPoints.name = "Stars_FAR";
    scene.add(this.farPoints);

    // ----------------------------
    // NEAR (dense pool)
    // ----------------------------
    const nearCount = Math.max(0, options.nearCount ?? 2400);
    const nearInnerRadius = Math.max(this.exclusionRadius, options.nearInnerRadius ?? 900);
    const nearOuterRadius = Math.max(nearInnerRadius + 1, options.nearOuterRadius ?? 5000);
    const nearSize = Math.max(0.1, options.nearSize ?? 1.65);
    const nearBaseColor = options.nearBaseColor ?? 0xffdd70;

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

    // Vertex colors for reveal control (RGB + alpha encoded in material.opacity via per-vertex brightness)
    // We do: color = baseColor * brightness, where brightness is 0..1.
    // PointsMaterial supports vertexColors = true for RGB.
    // We'll encode reveal into RGB brightness (simple + compatible).
    this.nearColors = new Float32Array(nearCount * 3);
    this.nearGeom.setAttribute("color", new THREE.BufferAttribute(this.nearColors, 3));

    this.nearMat = new THREE.PointsMaterial({
      color: nearBaseColor, // acts as a multiplier when vertexColors is true
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

    // Reveal ordering (stable)
    this.nearOrder = this.makeStableRandomOrder(nearCount);

    // Initial reveal
    this.nearReveal01 = clamp01(options.nearReveal01 ?? 0.33);
    this.nearTargetReveal01 = this.nearReveal01;
    this.applyNearRevealToColors(this.nearReveal01, 0.9);

    // Ensure GPU sees initial colors
    (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ----------------------------------------------------------
  // Public controls (Harmony will orchestrate later)
  // ----------------------------------------------------------

  /** Set whether NEAR reveal should be driven by audio energy in update(). */
  public setAudioDriven(enabled: boolean): void {
    this.audioDriven = Boolean(enabled);
  }

  /** Feed latest audio frame (optional). */
  public setAudioFrame(frame: AudioFrame): void {
    this.lastAudio = {
      energy: safe01(frame.energy, this.lastAudio.energy),
      low: safe01(frame.low, this.lastAudio.low),
      mid: safe01(frame.mid, this.lastAudio.mid),
      high: safe01(frame.high, this.lastAudio.high),
    };
  }

  /**
   * Directly set NEAR reveal target (0..1).
   * Use this for Ritual progress, Gong bursts, etc.
   */
  public setNearRevealTarget01(v: number): void {
    this.nearTargetReveal01 = clamp01(v);
  }

  /** Set a baseline reveal value (e.g. 0.33). */
  public setNearBaselineReveal01(v: number): void {
    this.nearReveal01 = clamp01(v);
    this.nearTargetReveal01 = this.nearReveal01;
  }

  /**
   * Set base colors for FAR and NEAR (future Harmony hook).
   * Note: NEAR uses vertex colors multiplied by this base color.
   */
  public setColors(opts: { farColor?: number; nearColor?: number }): void {
    if (typeof opts.farColor === "number") {
      this.farMat.color.setHex(opts.farColor);
    }
    if (typeof opts.nearColor === "number") {
      this.nearMat.color.setHex(opts.nearColor);
    }
  }

  /**
   * Simple "pulse" hook for gong-like events:
   * temporarily push NEAR reveal to a higher target.
   */
  public pulseNearReveal(amount01: number): void {
    const boosted = clamp01(this.nearTargetReveal01 + clamp01(amount01));
    this.nearTargetReveal01 = boosted;
  }

  // ----------------------------------------------------------
  // Update
  // ----------------------------------------------------------

  public update(dt: number): void {
    // NEAR reveal target from audio (v0 mapping)
    if (this.audioDriven) {
      // Tier mapping: energy controls reveal fraction (concept: 1/3, 2/3, 3/3)
      // We map energy to reveal in a soft way:
      //  - energy 0.00 -> 0.33
      //  - energy 0.50 -> 0.66
      //  - energy 1.00 -> 1.00
      const e = this.lastAudio.energy;
      const target = e < 0.5 ? lerp(0.33, 0.66, e / 0.5) : lerp(0.66, 1.0, (e - 0.5) / 0.5);

      // Audio target should not override a stronger external target.
      // So we take the max: ritual can push higher than audio.
      this.nearTargetReveal01 = Math.max(this.nearTargetReveal01, clamp01(target));
    }

    // Ease toward target
    const t = 1 - Math.exp(-this.nearRevealEase * Math.max(0, dt));
    const prev = this.nearReveal01;
    this.nearReveal01 = lerp(this.nearReveal01, this.nearTargetReveal01, t);

    // After approaching target, gently relax target back toward baseline if it was boosted
    // (prevents permanent "stuck at full" after pulses unless something keeps driving it).
    // This will later be replaced by Harmony + Ritual rules.
    if (this.nearTargetReveal01 > this.nearReveal01) {
      // keep target for now
    } else {
      // relax target slowly toward baseline tier derived from audio (or 0.33 if audio not driving)
      const baseline = this.audioDriven ? this.nearTargetReveal01 : 0.33;
      this.nearTargetReveal01 = lerp(this.nearTargetReveal01, baseline, 0.02);
    }

    // If change is tiny, avoid updating GPU every frame
    if (Math.abs(this.nearReveal01 - prev) > 0.002) {
      // Brightness ties to reveal (subtle). At higher reveal, stars also burn hotter.
      const brightness = lerp(0.65, 1.0, this.nearReveal01);
      this.applyNearRevealToColors(this.nearReveal01, brightness);

      (this.nearGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
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

    if (outerRadius <= 0) throw new Error(`[StarSystem] outerRadius must be > 0. Got ${outerRadius}.`);
    if (innerRadius < 0) throw new Error(`[StarSystem] innerRadius must be >= 0. Got ${innerRadius}.`);
    if (innerRadius >= outerRadius) {
      throw new Error(
        `[StarSystem] innerRadius (${innerRadius}) must be < outerRadius (${outerRadius}).`,
      );
    }

    const positions = new Float32Array(count * 3);

    // Uniform distribution in a spherical shell (volume-uniform)
    const r0c = innerRadius * innerRadius * innerRadius;
    const Rc = outerRadius * outerRadius * outerRadius;

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const phi = Math.acos(u);

      const t = Math.random();
      const r = Math.cbrt(r0c + t * (Rc - r0c));

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    return positions;
  }

  private makeStableRandomOrder(count: number): Uint32Array {
    // Stable-ish shuffle: deterministic order is not required yet, just not "index order".
    // We'll build a simple Fisher-Yates over indices.
    const arr = new Uint32Array(count);
    for (let i = 0; i < count; i++) arr[i] = i;

    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }

    return arr;
  }

  private applyNearRevealToColors(reveal01: number, brightness: number): void {
    const count = this.nearOrder.length;
    const visibleCount = Math.floor(count * clamp01(reveal01));

    // Set all to "off" first (cheap: single pass)
    // Then enable first N by order.
    // Brightness is encoded into RGB, material base color multiplies it.
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      this.nearColors[idx + 0] = 0;
      this.nearColors[idx + 1] = 0;
      this.nearColors[idx + 2] = 0;
    }

    for (let k = 0; k < visibleCount; k++) {
      const i = this.nearOrder[k];
      const idx = i * 3;

      // Slight random variance per star for twinkle-like variation (static for now)
      const v = brightness * (0.82 + Math.random() * 0.18);

      this.nearColors[idx + 0] = v;
      this.nearColors[idx + 1] = v;
      this.nearColors[idx + 2] = v;
    }
  }
}
