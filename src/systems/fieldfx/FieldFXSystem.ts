// src/systems/fieldfx/FieldFXSystem.ts
// ============================================================
// THE STILL — FieldFXSystem (BAND Morph Conductor)
// ------------------------------------------------------------
// Responsibilities:
//  - Owns BAND “morph” states: stars <-> embers/dust/fireflies/leaves (rain/snow later)
//  - Smoothly animates OUT of a mode back to pristine stars (no snap-delay)
//  - Smoothly animates INTO a mode from stars
//
// Key fix in this version:
//  - When targetMode === "stars", we still apply morph using the CURRENT active emitter
//    so the return-to-stars is animated, not “wait then pop”.
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../../core/EventBus";
import { EmbersEmitter } from "./emitters/EmbersEmitter";
import { DustEmitter } from "./emitters/DustEmitter";
import { FirefliesEmitter } from "./emitters/FirefliesEmitter";
import { LeavesEmitter } from "./emitters/LeavesEmitter";

export type FieldFXMode =
  | "stars"
  | "embers"
  | "dust"
  | "rain"
  | "snow"
  | "fireflies"
  | "leaves";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const isFiniteNumber = (v: number): boolean => Number.isFinite(v) && !Number.isNaN(v);

type ResolvedMode = "stars" | "embers" | "dust" | "fireflies" | "leaves";

const normalizeMode = (mode: FieldFXMode): ResolvedMode => {
  if (mode === "embers") return "embers";
  if (mode === "dust") return "dust";
  if (mode === "fireflies") return "fireflies";
  if (mode === "leaves") return "leaves";
  return "stars";
};

type TransitionProfile = {
  morphEase: number;
  burstDuration: number;
  burstStrengthBoost: number;
  burstMorphEaseBoost: number;
};

const DEFAULT_TRANSITION: TransitionProfile = {
  morphEase: 8.5,
  burstDuration: 0.5,
  burstStrengthBoost: 2.0,
  burstMorphEaseBoost: 1.65,
};

const TRANSITIONS: Record<ResolvedMode, TransitionProfile> = {
  embers: { morphEase: 8.5, burstDuration: 0.6, burstStrengthBoost: 2.25, burstMorphEaseBoost: 1.8 },
  dust: { morphEase: 8.0, burstDuration: 0.45, burstStrengthBoost: 1.8, burstMorphEaseBoost: 1.5 },
  fireflies: { morphEase: 8.2, burstDuration: 0.5, burstStrengthBoost: 2.05, burstMorphEaseBoost: 1.6 },
  leaves: { morphEase: 7.8, burstDuration: 0.55, burstStrengthBoost: 1.9, burstMorphEaseBoost: 1.55 },

  // ⭐ Make “return to stars” feel immediate.
  stars: { morphEase: 16.0, burstDuration: 0.0, burstStrengthBoost: 1.0, burstMorphEaseBoost: 1.0 },
};

const easeOutCubic01 = (t: number): number => {
  const x = clamp01(t);
  const inv = 1 - x;
  return 1 - inv * inv * inv;
};

type MaterialState = {
  size: number;
  opacity: number;
  color: THREE.Color;
  blending: THREE.Blending;
  transparent: boolean;
  depthWrite: boolean;
  sizeAttenuation: boolean;
};

export class FieldFXSystem {
  private readonly bus: EventBus;

  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private bandPoints: THREE.Points | null = null;

  private geom: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private livePositions: Float32Array | null = null;

  private mat: THREE.PointsMaterial | null = null;

  // Canonical “stars baseline” captured at attach-time
  private basePositions: Float32Array | null = null;
  private baseMat: MaterialState | null = null;

  private mode: FieldFXMode = "stars";
  private targetMode: FieldFXMode = "stars";

  private activeResolved: ResolvedMode = "stars";
  private targetResolved: ResolvedMode = "stars";

  // Cross-morph progress between activeResolved -> targetResolved
  private blend01 = 1; // 1 = fully at target
  private burstTimeLeft = 0;
  private transition: TransitionProfile = { ...DEFAULT_TRANSITION };

  private readonly embers = new EmbersEmitter();
  private readonly dust = new DustEmitter();
  private readonly fireflies = new FirefliesEmitter();
  private readonly leaves = new LeavesEmitter();

  private readonly tmpColorA = new THREE.Color();
  private readonly tmpColorB = new THREE.Color();
  private readonly tmpColorOut = new THREE.Color();

  private readonly matA: MaterialState = {
    size: 0.04,
    opacity: 1,
    color: new THREE.Color(),
    blending: THREE.NormalBlending,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  };

  private readonly matB: MaterialState = {
    size: 0.04,
    opacity: 1,
    color: new THREE.Color(),
    blending: THREE.NormalBlending,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  };

  private readonly onDevModeSet: (payload: unknown) => void;

  constructor(opts: { bus: EventBus }) {
    this.bus = opts.bus;

    this.onDevModeSet = (payload: unknown) => {
      const mode = (payload as any)?.mode as FieldFXMode | undefined;
      if (!mode) return;
      this.setMode(mode);
    };

    this.bus.on("fieldfx:mode:set", this.onDevModeSet);
  }

  public setTargets(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;
    this.tryAttachByName();
  }

  public attachBandPoints(points: THREE.Points): void {
    if (this.bandPoints === points) return;

    this.bandPoints = points;

    this.geom = points.geometry as THREE.BufferGeometry;
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos || !(pos.array instanceof Float32Array) || pos.itemSize !== 3) {
      throw new Error("[FieldFXSystem] BAND position attribute must be Float32Array itemSize=3.");
    }

    this.posAttr = pos;
    this.livePositions = pos.array as Float32Array;

    // Snapshot canonical base positions (stars)
    this.basePositions = new Float32Array(this.livePositions.length);
    this.basePositions.set(this.livePositions);

    // Snapshot canonical base material
    const m = points.material as THREE.PointsMaterial;
    this.mat = m;

    this.baseMat = {
      size: m.size,
      opacity: m.opacity,
      color: m.color.clone(),
      blending: m.blending,
      transparent: m.transparent,
      depthWrite: m.depthWrite,
      sizeAttenuation: (m as any).sizeAttenuation ?? true,
    };

    // Attach emitters (they build their own sim buffers)
    this.embers.attach(points);
    this.dust.attach(points);
    this.fireflies.attach(points);
    this.leaves.attach(points);

    // Apply current mode immediately without popping
    this.activeResolved = normalizeMode(this.mode);
    this.targetResolved = this.activeResolved;
    this.targetMode = this.mode;

    // Ensure sim buffers are aligned
    this.resetSimFor(this.activeResolved);

    // Force a clean “settled” frame
    this.blend01 = 1;
    this.burstTimeLeft = 0;
    this.applyComposite(1);
  }

  public tryAttachByName(name = "Stars_BAND"): boolean {
    if (this.bandPoints) return true;
    if (!this.scene) return false;

    const obj = this.scene.getObjectByName(name);
    if (obj && (obj as any).isPoints) {
      this.attachBandPoints(obj as THREE.Points);
      return true;
    }
    return false;
  }

  public setMode(mode: FieldFXMode): void {
    const nextResolved = normalizeMode(mode);
    if (nextResolved === this.targetResolved && mode === this.targetMode) return;

    this.targetMode = mode;
    this.targetResolved = nextResolved;

    if (!this.bandPoints) {
      this.mode = mode;
      this.activeResolved = nextResolved;
      return;
    }

    // If already there, ignore.
    if (this.activeResolved === this.targetResolved && this.blend01 >= 0.9999) {
      this.mode = mode;
      return;
    }

    // Start cross-morph: active -> target
    this.transition = { ...DEFAULT_TRANSITION, ...(TRANSITIONS[this.targetResolved] ?? {}) };
    this.blend01 = 0;

    // Only burst when entering a non-stars target
    this.burstTimeLeft = this.targetResolved === "stars" ? 0 : this.transition.burstDuration;

    // Make sure target sim starts from baseline (no teleport)
    this.resetSimFor(this.targetResolved);

    // Mode is “requested”; activeResolved remains until blend completes
    this.mode = mode;
  }

  public update(dt: number): void {
    if (!this.bandPoints || !this.basePositions || !this.posAttr || !this.livePositions || !this.baseMat || !this.mat) return;

    const d = Math.max(0, isFiniteNumber(dt) ? dt : 0);
    if (d <= 0) return;

    // Burst progress
    const burstActive = this.burstTimeLeft > 0;
    let burst01 = 0;

    if (burstActive) {
      this.burstTimeLeft = Math.max(0, this.burstTimeLeft - d);
      const dur = Math.max(1e-6, this.transition.burstDuration);
      burst01 = clamp01(this.burstTimeLeft / dur);
      burst01 = easeOutCubic01(burst01);
    }

    const easeBoost = burstActive ? this.transition.burstMorphEaseBoost : 1;
    const ease = Math.max(0.0001, this.transition.morphEase * easeBoost);
    const t = 1 - Math.exp(-ease * d);

    // progress blend toward 1
    this.blend01 = lerp(this.blend01, 1, t);

    // We want BOTH sims alive during a crossfade.
    // Strength keeps motion present during transitions.
    const strengthBoost = burstActive ? lerp(1, this.transition.burstStrengthBoost, burst01) : 1;

    const inW = clamp01(this.blend01);
    const outW = 1 - inW;

    // Keep sims running as long as they have weight
    this.simulateMode(this.activeResolved, d, clamp01(outW * strengthBoost));
    this.simulateMode(this.targetResolved, d, clamp01(inW * strengthBoost));

    // Compose final positions + material in one pass
    this.applyComposite(inW);

    // Finish
    if (this.blend01 >= 0.9995) {
      this.blend01 = 1;
      this.activeResolved = this.targetResolved;
      this.mode = this.targetMode;
    }
  }

  public dispose(): void {
    this.embers.detach();
    this.dust.detach();
    this.fireflies.detach();
    this.leaves.detach();

    this.bus.off("fieldfx:mode:set", this.onDevModeSet);

    this.bandPoints = null;
    this.scene = null;
    this.camera = null;

    this.geom = null;
    this.posAttr = null;
    this.livePositions = null;

    this.mat = null;

    this.basePositions = null;
    this.baseMat = null;

    this.burstTimeLeft = 0;
    this.blend01 = 1;
  }

  // ---------------------------------------------------------------------------
  // Composite (the magic: no stars flash, no last-writer-wins)
  // ---------------------------------------------------------------------------

  private applyComposite(inWeight01: number): void {
    if (!this.basePositions || !this.livePositions || !this.posAttr || !this.baseMat || !this.mat) return;

    const inW = clamp01(inWeight01);
    const outW = 1 - inW;

    // Positions
    if (this.activeResolved === this.targetResolved) {
      // Single-mode morph vs base
      if (this.activeResolved === "stars") {
        this.livePositions.set(this.basePositions);
      } else {
        const simA = this.getSim(this.activeResolved);
        if (simA) {
          const base = this.basePositions;
          const live = this.livePositions;
          for (let i = 0; i < live.length; i++) {
            live[i] = lerp(base[i], simA[i], inW);
          }
        } else {
          this.livePositions.set(this.basePositions);
        }
      }
    } else {
      // Crossfade A -> B without ever showing “pure stars” mid-transition
      const base = this.basePositions;
      const live = this.livePositions;

      const simFrom = this.getSim(this.activeResolved);
      const simTo = this.getSim(this.targetResolved);

      if (!simFrom && !simTo) {
        live.set(base);
      } else if (!simFrom) {
        // base -> to
        for (let i = 0; i < live.length; i++) live[i] = lerp(base[i], (simTo as Float32Array)[i], inW);
      } else if (!simTo) {
        // from -> base
        for (let i = 0; i < live.length; i++) live[i] = lerp((simFrom as Float32Array)[i], base[i], inW);
      } else {
        for (let i = 0; i < live.length; i++) {
          const posFrom = lerp(base[i], simFrom[i], outW);
          const posTo = lerp(base[i], simTo[i], inW);
          live[i] = lerp(posFrom, posTo, inW);
        }
      }
    }

    this.posAttr.needsUpdate = true;

    // Material
    this.sampleMaterial(this.activeResolved, outW, this.matA);
    this.sampleMaterial(this.targetResolved, inW, this.matB);

    // Blend A->B in a stable way
    const m = this.mat;

    m.size = lerp(this.matA.size, this.matB.size, inW);
    m.opacity = lerp(this.matA.opacity, this.matB.opacity, inW);

    this.tmpColorOut.lerpColors(this.matA.color, this.matB.color, inW);
    m.color.copy(this.tmpColorOut);

    // Blending + flags: choose the dominant side to avoid “halfway render state weirdness”
    const dom = inW >= 0.5 ? this.matB : this.matA;
    m.blending = dom.blending;
    m.transparent = dom.transparent;
    m.depthWrite = dom.depthWrite;
    (m as any).sizeAttenuation = dom.sizeAttenuation;

    m.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Sim + sampling helpers
  // ---------------------------------------------------------------------------

  private resetSimFor(mode: ResolvedMode): void {
    if (mode === "embers") this.embers.resetSimToBase();
    if (mode === "dust") this.dust.resetSimToBase();
    if (mode === "fireflies") this.fireflies.resetSimToBase();
    if (mode === "leaves") this.leaves.resetSimToBase();
  }

  private simulateMode(mode: ResolvedMode, dt: number, strength01: number): void {
    const s = clamp01(strength01);
    if (s <= 0.00001) return;

    if (mode === "embers") this.embers.simulate(dt, s);
    if (mode === "dust") this.dust.simulate(dt, s);
    if (mode === "fireflies") this.fireflies.simulate(dt, s);
    if (mode === "leaves") this.leaves.simulate(dt, s);
  }

  private getSim(mode: ResolvedMode): Float32Array | null {
    if (mode === "embers") return this.embers.getSimPositions();
    if (mode === "dust") return this.dust.getSimPositions();
    if (mode === "fireflies") return this.fireflies.getSimPositions();
    if (mode === "leaves") return this.leaves.getSimPositions();
    return null;
  }

  private sampleMaterial(mode: ResolvedMode, morph01: number, out: MaterialState): void {
    if (!this.baseMat) return;

    const t = clamp01(morph01);

    // Start with base
    out.size = this.baseMat.size;
    out.opacity = this.baseMat.opacity;
    out.color.copy(this.baseMat.color);
    out.blending = this.baseMat.blending;
    out.transparent = this.baseMat.transparent;
    out.depthWrite = this.baseMat.depthWrite;
    out.sizeAttenuation = this.baseMat.sizeAttenuation;

    if (mode === "stars") return;

    if (mode === "embers") this.embers.sampleMaterial(t, out);
    if (mode === "dust") this.dust.sampleMaterial(t, out);
    if (mode === "fireflies") this.fireflies.sampleMaterial(t, out);
    if (mode === "leaves") this.leaves.sampleMaterial(t, out);
  }
}