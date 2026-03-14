// src/systems/fieldfx/FieldFXSystem.ts
// ============================================================
// THE STILL — FieldFXSystem (BAND Morph Conductor)
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../../core/EventBus";
import { EmbersEmitter } from "./emitters/EmbersEmitter";
import { DustEmitter } from "./emitters/DustEmitter";
import { FirefliesEmitter } from "./emitters/FirefliesEmitter";
import { LeavesEmitter } from "./emitters/LeavesEmitter";
import { RainEmitter } from "./emitters/RainEmitter";
import { SnowEmitter } from "./emitters/SnowEmitter";

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
const isFiniteNumber = (v: number): boolean =>
  Number.isFinite(v) && !Number.isNaN(v);

type ResolvedMode =
  | "stars"
  | "embers"
  | "dust"
  | "rain"
  | "snow"
  | "fireflies"
  | "leaves";

const normalizeMode = (mode: FieldFXMode | null): ResolvedMode => {
  if (mode === "embers") return "embers";
  if (mode === "dust") return "dust";
  if (mode === "rain") return "rain";
  if (mode === "snow") return "snow";
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
  embers: {
    morphEase: 8.5,
    burstDuration: 0.6,
    burstStrengthBoost: 2.25,
    burstMorphEaseBoost: 1.8,
  },
  dust: {
    morphEase: 8.0,
    burstDuration: 0.45,
    burstStrengthBoost: 1.8,
    burstMorphEaseBoost: 1.5,
  },
  fireflies: {
    morphEase: 8.2,
    burstDuration: 0.5,
    burstStrengthBoost: 2.05,
    burstMorphEaseBoost: 1.6,
  },
  leaves: {
    morphEase: 7.8,
    burstDuration: 0.55,
    burstStrengthBoost: 1.9,
    burstMorphEaseBoost: 1.55,
  },

  rain: {
    morphEase: 9.5,
    burstDuration: 0.4,
    burstStrengthBoost: 1.85,
    burstMorphEaseBoost: 1.45,
  },
  snow: {
    morphEase: 7.6,
    burstDuration: 0.55,
    burstStrengthBoost: 1.7,
    burstMorphEaseBoost: 1.35,
  },

  stars: {
    morphEase: 16.0,
    burstDuration: 0.0,
    burstStrengthBoost: 1.0,
    burstMorphEaseBoost: 1.0,
  },
};

const easeOutCubic01 = (t: number): number => {
  const x = clamp01(t);
  const inv = 1 - x;
  return 1 - inv * inv * inv;
};

const smoothstep01 = (edge0: number, edge1: number, x: number): number => {
  const e0 = edge0;
  const e1 = Math.max(edge0 + 1e-6, edge1);
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
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

type FieldFXBlendMode = "additive" | "normal" | "base";

type FieldFXLookProfile = {
  sizeMul: number;
  opacityMul: number;
  intensity: number;
  bloomBias: number;
  audioResponse: number;
  blendMode: FieldFXBlendMode;
  tint: THREE.Color | null;
  tintMix: number;
};

const FIELD_FX_LOOKS: Record<ResolvedMode, FieldFXLookProfile> = {
  stars: {
    sizeMul: 1.12,
    opacityMul: 0.92,
    intensity: 1.12,
    bloomBias: 0.38,
    audioResponse: 0.18,
    blendMode: "additive",
    tint: new THREE.Color("#d6defd"),
    tintMix: 0.16,
  },
  embers: {
    sizeMul: 1.2,
    opacityMul: 1.05,
    intensity: 1.42,
    bloomBias: 0.92,
    audioResponse: 0.55,
    blendMode: "additive",
    tint: new THREE.Color("#ffd36b"),
    tintMix: 0.10,
  },
  dust: {
    sizeMul: 1.1,
    opacityMul: 0.94,
    intensity: 1.02,
    bloomBias: 0.48,
    audioResponse: 0.4,
    blendMode: "additive",
    tint: new THREE.Color("#efe4d1"),
    tintMix: 0.08,
  },
  rain: {
    sizeMul: 1.06,
    opacityMul: 1.0,
    intensity: 0.96,
    bloomBias: 0.22,
    audioResponse: 0.22,
    blendMode: "normal",
    tint: new THREE.Color("#e7f2ff"),
    tintMix: 0.1,
  },
  snow: {
    sizeMul: 1.16,
    opacityMul: 1.02,
    intensity: 1.02,
    bloomBias: 0.32,
    audioResponse: 0.18,
    blendMode: "normal",
    tint: new THREE.Color("#f4f9ff"),
    tintMix: 0.12,
  },
  fireflies: {
    sizeMul: 1.22,
    opacityMul: 1.04,
    intensity: 1.36,
    bloomBias: 1.0,
    audioResponse: 0.62,
    blendMode: "additive",
    tint: new THREE.Color("#fff6a8"),
    tintMix: 0.16,
  },
  leaves: {
    sizeMul: 1.14,
    opacityMul: 1.0,
    intensity: 0.88,
    bloomBias: 0.08,
    audioResponse: 0.16,
    blendMode: "normal",
    tint: new THREE.Color("#c6a96b"),
    tintMix: 0.08,
  },
};

// Audio frame contract we care about (from AudioSystem audio:frame payload.frame)
type AudioFrame01 = {
  energy: number;
  low: number;
  mid: number;
  high: number;
  impact01: number;
  peak01?: number;
  quiet?: boolean;
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

  private basePositions: Float32Array | null = null;
  private baseMat: MaterialState | null = null;

  private off = false;

  private mode: FieldFXMode | null = "stars";
  private targetMode: FieldFXMode | null = "stars";

  private activeResolved: ResolvedMode = "stars";
  private targetResolved: ResolvedMode = "stars";

  private blend01 = 1;
  private burstTimeLeft = 0;
  private transition: TransitionProfile = { ...DEFAULT_TRANSITION };
  private burstAllowed = false;

  private readonly embers = new EmbersEmitter();
  private readonly dust = new DustEmitter();
  private readonly fireflies = new FirefliesEmitter();
  private readonly leaves = new LeavesEmitter();
  private readonly rain = new RainEmitter();
  private readonly snow = new SnowEmitter();

  private readonly tmpColorOut = new THREE.Color();
  private readonly tmpTintColor = new THREE.Color();

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

  // ------------------------------------------------------------
  // Audio-reactive intensity (light/heavy)
  // ------------------------------------------------------------

  private audioFrame: AudioFrame01 | null = null;
  private hasAudioFrame = false;

  // Optional extra smoothing in this system (keeps “physics” feel stable)
  private smEnergy = 0;
  private smLow = 0;
  private smMid = 0;
  private smHigh = 0;
  private smImpact = 0;
  private smQuiet = true;

  // FieldFX-side smoothing (seconds^-1), separate from AudioSystem smoothing.
  private readonly fxAttackHz = 7.5;
  private readonly fxReleaseHz = 4.0;

  // Gust helper (dust/leaves) driven by impact
  private gust01 = 0;
  private readonly gustAttackHz = 18;
  private readonly gustReleaseHz = 2.6;

  // Tab-switch / suspend guard:
  // if we see a big dt, reset emitter sims so motion doesn’t “step”
  private readonly simGapResetSec = 0.22;

  // ------------------------------------------------------------
  // Density control (Option B: fewer rendered points at low energy)
  // ------------------------------------------------------------
  // These are intentionally low so rain/snow can be “barely there” instead of off.
  private readonly rainMinDensity = 0.06;
  private readonly snowMinDensity = 0.08;

  // Optional: if emitter supports soft thresholding, we’ll set it.
  private readonly densitySoftness = 0.035;

  // Bus handler references for cleanup
  private readonly onAudioFrame: (payload: unknown) => void;

  constructor(opts: { bus: EventBus }) {
    this.bus = opts.bus;

    this.onDevModeSet = (payload: unknown) => {
      // Explicit contract:
      // - mode: null      => OFF
      // - mode: "stars"|... => ON that mode
      // - mode: undefined / missing => NO-OP
      const mode = (payload as any)?.mode as FieldFXMode | null | undefined;
      if (mode === undefined) return;
      this.setMode(mode);
    };

    this.onAudioFrame = (payload: unknown) => {
      const frame = (payload as any)?.frame as AudioFrame01 | undefined;
      if (!frame) return;

      // Be defensive; AudioSystem should already guarantee 0..1.
      this.setAudioFrame({
        energy: clamp01(Number(frame.energy) || 0),
        low: clamp01(Number(frame.low) || 0),
        mid: clamp01(Number(frame.mid) || 0),
        high: clamp01(Number(frame.high) || 0),
        impact01: clamp01(Number(frame.impact01) || 0),
        peak01: clamp01(Number((frame as any).peak01) || 0),
        quiet: Boolean((frame as any).quiet),
      });
    };

    this.bus.on("fieldfx:mode:set", this.onDevModeSet);

    // MVP wiring: listen directly.
    // Later, if you want ParticleFXSystem to forward, keep setAudioFrame() and remove this listener.
    this.bus.on("audio:frame", this.onAudioFrame);
  }

  // Allows ParticleFXSystem (or any orchestrator) to feed audio without direct bus listening.
  public setAudioFrame(frame: AudioFrame01): void {
    this.audioFrame = frame;
    this.hasAudioFrame = true;
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
      throw new Error(
        "[FieldFXSystem] BAND position attribute must be Float32Array itemSize=3.",
      );
    }

    this.posAttr = pos;
    this.livePositions = pos.array as Float32Array;

    this.basePositions = new Float32Array(this.livePositions.length);
    this.basePositions.set(this.livePositions);

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

    this.embers.attach(points);
    this.dust.attach(points);
    this.fireflies.attach(points);
    this.leaves.attach(points);
    this.rain.attach(points);
    this.snow.attach(points);

    this.activeResolved = normalizeMode(this.mode);
    this.targetResolved = this.activeResolved;
    this.targetMode = this.mode;

    this.resetSimFor(this.activeResolved);

    this.blend01 = 1;
    this.burstTimeLeft = 0;
    this.burstAllowed = false;

    if (this.off || this.mode === null) {
      this.applyOffNow();
      return;
    }

    this.applyComposite(1);
  }

  public tryAttachByName(name = "Stars_BAND"): boolean {
    if (this.bandPoints) return true;
    if (!this.scene) return false;

    const obj = this.scene.getObjectByName(name);
    if (!obj) return false;

    // Direct hit
    if ((obj as any).isPoints) {
      this.attachBandPoints(obj as THREE.Points);
      return true;
    }

    // Fallback: search children
    const pointsChild = obj.getObjectByProperty("isPoints", true) as THREE.Points | undefined;
    if (pointsChild) {
      this.attachBandPoints(pointsChild);
      return true;
    }

    return false;
  }

  public setMode(mode: FieldFXMode | null): void {
    if (mode === null) {
      if (this.off && this.targetMode === null) return;
      this.off = true;
      this.mode = null;
      this.targetMode = null;
      this.targetResolved = "stars";
      this.activeResolved = "stars";
      this.blend01 = 1;
      this.burstTimeLeft = 0;
      this.burstAllowed = false;

      this.applyOffNow();
      return;
    }

    const wasOff = this.off;
    this.off = false;

    const nextResolved = normalizeMode(mode);
    if (!wasOff && nextResolved === this.targetResolved && mode === this.targetMode)
      return;

    this.targetMode = mode;
    this.targetResolved = nextResolved;

    if (!this.bandPoints) {
      this.mode = mode;
      this.activeResolved = nextResolved;
      return;
    }

    this.bandPoints.visible = true;

    if (this.activeResolved === this.targetResolved && this.blend01 >= 0.9999) {
      this.mode = mode;
      return;
    }

    this.transition = {
      ...DEFAULT_TRANSITION,
      ...(TRANSITIONS[this.targetResolved] ?? {}),
    };
    this.blend01 = 0;

    const enteringFromStars =
      (wasOff || this.activeResolved === "stars") && this.targetResolved !== "stars";
    this.burstAllowed = enteringFromStars;
    this.burstTimeLeft = enteringFromStars ? this.transition.burstDuration : 0;

    this.resetSimFor(this.targetResolved);

    this.mode = mode;

    if (wasOff) {
      this.applyBaseNow();
      this.activeResolved = "stars";
      this.transition = {
        ...DEFAULT_TRANSITION,
        ...(TRANSITIONS[this.targetResolved] ?? {}),
      };
      this.blend01 = 0;

      const fromStars = this.targetResolved !== "stars";
      this.burstAllowed = fromStars;
      this.burstTimeLeft = fromStars ? this.transition.burstDuration : 0;
    }
  }

  public update(dt: number): void {
    if (this.off) {
      if (this.bandPoints) this.bandPoints.visible = false;
      return;
    }

    if (
      !this.bandPoints ||
      !this.basePositions ||
      !this.posAttr ||
      !this.livePositions ||
      !this.baseMat ||
      !this.mat
    )
      return;

    const d = Math.max(0, isFiniteNumber(dt) ? dt : 0);
    if (d <= 0) return;

    // ------------------------------------------------------------
    // dt gap reset (tab switch / suspend)
    // ------------------------------------------------------------
    if (d > this.simGapResetSec) {
      // Reset both ends of the transition so we don’t “step” a long integration frame.
      this.resetSimFor(this.activeResolved);
      if (this.targetResolved !== this.activeResolved)
        this.resetSimFor(this.targetResolved);

      // Also soften any gust carry so it doesn’t snap.
      this.gust01 = 0;
    }

    // ------------------------------------------------------------
    // Update smoothed audio (if any)
    // ------------------------------------------------------------
    this.updateSmoothedAudio(d);

    // ------------------------------------------------------------
    // Density (Option B): drive rain/snow sparsity from smoothed energy
    // ------------------------------------------------------------
    this.applyWeatherDensity();

    const burstActive = this.burstAllowed && this.burstTimeLeft > 0;
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

    this.blend01 = lerp(this.blend01, 1, t);

    const strengthBoost = burstActive
      ? lerp(1, this.transition.burstStrengthBoost, burst01)
      : 1;

    const inW = clamp01(this.blend01);
    const outW = 1 - inW;

    // ------------------------------------------------------------
    // Audio-driven “light/heavy” per-mode mapping
    // ------------------------------------------------------------
    const audioMulActive = this.getAudioIntensityMul(this.activeResolved, d);
    const audioMulTarget = this.getAudioIntensityMul(this.targetResolved, d);

    this.simulateMode(
      this.activeResolved,
      d,
      clamp01(outW * strengthBoost) * audioMulActive,
    );
    this.simulateMode(
      this.targetResolved,
      d,
      clamp01(inW * strengthBoost) * audioMulTarget,
    );

    this.applyComposite(inW);

    if (this.blend01 >= 0.9995) {
      this.blend01 = 1;
      this.activeResolved = this.targetResolved;
      this.mode = this.targetMode;

      this.burstTimeLeft = 0;
      this.burstAllowed = false;
    }
  }

  public dispose(): void {
    this.embers.detach();
    this.dust.detach();
    this.fireflies.detach();
    this.leaves.detach();
    this.rain.detach();
    this.snow.detach();

    this.bus.off("fieldfx:mode:set", this.onDevModeSet);
    this.bus.off("audio:frame", this.onAudioFrame);

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

    this.off = false;
    this.mode = "stars";
    this.targetMode = "stars";
    this.burstAllowed = false;

    this.audioFrame = null;
    this.hasAudioFrame = false;
  }

  private applyBaseNow(): void {
    if (
      !this.bandPoints ||
      !this.basePositions ||
      !this.livePositions ||
      !this.posAttr ||
      !this.baseMat ||
      !this.mat
    )
      return;

    this.livePositions.set(this.basePositions);
    this.posAttr.needsUpdate = true;

    this.mat.size = this.baseMat.size;
    this.mat.opacity = this.baseMat.opacity;
    this.mat.color.copy(this.baseMat.color);

    const stateChanged =
      this.mat.blending !== this.baseMat.blending ||
      this.mat.transparent !== this.baseMat.transparent ||
      this.mat.depthWrite !== this.baseMat.depthWrite ||
      (this.mat as any).sizeAttenuation !== this.baseMat.sizeAttenuation;

    this.mat.blending = this.baseMat.blending;
    this.mat.transparent = this.baseMat.transparent;
    this.mat.depthWrite = this.baseMat.depthWrite;
    (this.mat as any).sizeAttenuation = this.baseMat.sizeAttenuation;

    if (stateChanged) this.mat.needsUpdate = true;
  }

  private applyOffNow(): void {
    this.applyBaseNow();

    this.burstTimeLeft = 0;
    this.burstAllowed = false;
    this.blend01 = 1;
    this.activeResolved = "stars";
    this.targetResolved = "stars";

    if (this.bandPoints) this.bandPoints.visible = false;
  }

  private applyComposite(inWeight01: number): void {
    if (!this.basePositions || !this.livePositions || !this.posAttr || !this.baseMat || !this.mat)
      return;

    const inW = clamp01(inWeight01);
    const outW = 1 - inW;

    if (this.activeResolved === this.targetResolved) {
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
      const base = this.basePositions;
      const live = this.livePositions;

      const simFrom = this.getSim(this.activeResolved);
      const simTo = this.getSim(this.targetResolved);

      if (!simFrom && !simTo) {
        live.set(base);
      } else if (!simFrom) {
        for (let i = 0; i < live.length; i++)
          live[i] = lerp(base[i], (simTo as Float32Array)[i], inW);
      } else if (!simTo) {
        for (let i = 0; i < live.length; i++)
          live[i] = lerp((simFrom as Float32Array)[i], base[i], inW);
      } else {
        for (let i = 0; i < live.length; i++) {
          const posFrom = lerp(base[i], simFrom[i], outW);
          const posTo = lerp(base[i], simTo[i], inW);
          live[i] = lerp(posFrom, posTo, inW);
        }
      }
    }

    this.posAttr.needsUpdate = true;

    let matW = inW;

    const enteringFromStars =
      this.activeResolved === "stars" &&
      this.targetResolved !== "stars" &&
      this.activeResolved !== this.targetResolved;

    if (enteringFromStars) {
      matW = smoothstep01(0.08, 0.24, inW);
    }

    const matOutW = 1 - matW;

    this.sampleMaterial(this.activeResolved, matOutW, this.matA);
    this.sampleMaterial(this.targetResolved, matW, this.matB);

    const m = this.mat;

    m.size = lerp(this.matA.size, this.matB.size, matW);
    m.opacity = lerp(this.matA.opacity, this.matB.opacity, matW);

    this.tmpColorOut.lerpColors(this.matA.color, this.matB.color, matW);
    m.color.copy(this.tmpColorOut);

    const dom = matW >= 0.5 ? this.matB : this.matA;

    const stateChanged =
      m.blending !== dom.blending ||
      m.transparent !== dom.transparent ||
      m.depthWrite !== dom.depthWrite ||
      (m as any).sizeAttenuation !== dom.sizeAttenuation;

    m.blending = dom.blending;
    m.transparent = dom.transparent;
    m.depthWrite = dom.depthWrite;
    (m as any).sizeAttenuation = dom.sizeAttenuation;

    if (stateChanged) m.needsUpdate = true;
  }

  // ---- sim + sampling helpers (this is where rain/snow must exist) ----

  private resetSimFor(mode: ResolvedMode): void {
    if (mode === "embers") this.embers.resetSimToBase();
    if (mode === "dust") this.dust.resetSimToBase();
    if (mode === "fireflies") this.fireflies.resetSimToBase();
    if (mode === "leaves") this.leaves.resetSimToBase();
    if (mode === "rain") this.rain.resetSimToBase();
    if (mode === "snow") this.snow.resetSimToBase();
  }

  private simulateMode(mode: ResolvedMode, dt: number, strength01: number): void {
    const s = clamp01(strength01);
    if (s <= 0.00001) return;

    if (mode === "embers") this.embers.simulate(dt, s);
    if (mode === "dust") this.dust.simulate(dt, s);
    if (mode === "fireflies") this.fireflies.simulate(dt, s);
    if (mode === "leaves") this.leaves.simulate(dt, s);
    if (mode === "rain") this.rain.simulate(dt, s);
    if (mode === "snow") this.snow.simulate(dt, s);
  }

  private getSim(mode: ResolvedMode): Float32Array | null {
    if (mode === "embers") return this.embers.getSimPositions();
    if (mode === "dust") return this.dust.getSimPositions();
    if (mode === "fireflies") return this.fireflies.getSimPositions();
    if (mode === "leaves") return this.leaves.getSimPositions();
    if (mode === "rain") return this.rain.getSimPositions();
    if (mode === "snow") return this.snow.getSimPositions();
    return null;
  }

  private sampleMaterial(mode: ResolvedMode, morph01: number, out: MaterialState): void {
    if (!this.baseMat) return;

    const t = clamp01(morph01);

    out.size = this.baseMat.size;
    out.opacity = this.baseMat.opacity;
    out.color.copy(this.baseMat.color);
    out.blending = this.baseMat.blending;
    out.transparent = this.baseMat.transparent;
    out.depthWrite = this.baseMat.depthWrite;
    out.sizeAttenuation = this.baseMat.sizeAttenuation;

    if (mode !== "stars") {
      if (mode === "embers") this.embers.sampleMaterial(t, out);
      if (mode === "dust") this.dust.sampleMaterial(t, out);
      if (mode === "fireflies") this.fireflies.sampleMaterial(t, out);
      if (mode === "leaves") this.leaves.sampleMaterial(t, out);
      if (mode === "rain") this.rain.sampleMaterial(t, out);
      if (mode === "snow") this.snow.sampleMaterial(t, out);
    }

    this.applyLookProfile(mode, t, out);
  }

  private applyLookProfile(mode: ResolvedMode, morph01: number, out: MaterialState): void {
    const look = FIELD_FX_LOOKS[mode];
    const t = clamp01(morph01);

    if (t <= 0) return;

    const visualAudioMul = this.getVisualAudioMul(mode, look.audioResponse);
    const bloomMul = lerp(1, 1 + look.bloomBias * 0.22, t);
    const intensityMul = lerp(1, look.intensity * visualAudioMul * bloomMul, t);

    out.size *= lerp(1, look.sizeMul, t);
    out.opacity = clamp01(out.opacity * lerp(1, look.opacityMul, t));

    if (look.tint && look.tintMix > 0) {
      this.tmpTintColor.copy(out.color);
      this.tmpTintColor.lerp(look.tint, clamp01(look.tintMix * t));
      out.color.copy(this.tmpTintColor);
    }

    out.color.multiplyScalar(intensityMul);

    if (look.blendMode === "additive") {
      out.blending = THREE.AdditiveBlending;
      out.transparent = true;
      out.depthWrite = false;
      out.sizeAttenuation = true;
      return;
    }

    if (look.blendMode === "normal") {
      out.blending = THREE.NormalBlending;
      out.transparent = true;
      out.depthWrite = false;
      out.sizeAttenuation = true;
      return;
    }

    // "base" falls through intentionally
  }

  private getVisualAudioMul(mode: ResolvedMode, response01: number): number {
    const r = clamp01(response01);
    if (r <= 0) return 1;

    if (!this.hasAudioFrame) return 1;

    let driver = 0;

    if (mode === "stars") {
      driver = clamp01(this.smMid * 0.7 + this.smHigh * 0.3);
    } else if (mode === "embers") {
      driver = clamp01(this.smMid * 0.72 + this.smHigh * 0.2 + this.smImpact * 0.08);
    } else if (mode === "dust") {
      driver = clamp01(this.smLow * 0.45 + this.smMid * 0.35 + this.gust01 * 0.2);
    } else if (mode === "rain") {
      driver = clamp01(this.smEnergy * 0.8 + this.smMid * 0.2);
    } else if (mode === "snow") {
      driver = clamp01(this.smEnergy * 0.75 + this.smHigh * 0.25);
    } else if (mode === "fireflies") {
      driver = clamp01(this.smHigh * 0.58 + this.smImpact * 0.22 + this.smEnergy * 0.2);
      if (this.smQuiet) driver *= 0.86;
    } else if (mode === "leaves") {
      driver = clamp01(this.smLow * 0.56 + this.gust01 * 0.28 + this.smMid * 0.16);
    }

    return lerp(1, 1 + driver * 0.55, r);
  }

  // ------------------------------------------------------------
  // Density control (Option B)
  // ------------------------------------------------------------

  private applyWeatherDensity(): void {
    // If no audio, default to full density (current behavior).
    if (!this.hasAudioFrame) {
      this.setEmitterDensity("rain", 1, this.densitySoftness);
      this.setEmitterDensity("snow", 1, this.densitySoftness);
      return;
    }

    // Use smoothed energy, but bias so very quiet music still yields a few flakes/drops.
    const e = clamp01(this.smEnergy);

    // Map energy -> density in a way that “arrives” earlier than speed.
    // You can tweak these edges anytime.
    const rainT = smoothstep01(0.03, 0.55, e);
    const snowT = smoothstep01(0.02, 0.48, e);

    const rainDensity = clamp01(lerp(this.rainMinDensity, 1, rainT));
    const snowDensity = clamp01(lerp(this.snowMinDensity, 1, snowT));

    this.setEmitterDensity("rain", rainDensity, this.densitySoftness);
    this.setEmitterDensity("snow", snowDensity, this.densitySoftness);
  }

  private setEmitterDensity(mode: "rain" | "snow", density01: number, softness01: number): void {
    const d = clamp01(density01);
    const s = clamp01(softness01);

    // We keep this duck-typed so FieldFXSystem compiles even before RainEmitter is upgraded.
    const emitter: any = mode === "rain" ? this.rain : this.snow;

    if (typeof emitter?.setDensity01 === "function") {
      emitter.setDensity01(d);
    }

    // Optional support if your emitter exposes a softness setter.
    if (typeof emitter?.setDensitySoftness01 === "function") {
      emitter.setDensitySoftness01(s);
    } else if (typeof emitter?.setDensitySoftness === "function") {
      emitter.setDensitySoftness(s);
    }
  }

  // ------------------------------------------------------------
  // Audio mapping (light/heavy)
  // ------------------------------------------------------------

  private updateSmoothedAudio(dt: number): void {
    if (!this.hasAudioFrame || !this.audioFrame) return;

    // One-pole AR smoothing for “feel” (separate from AudioSystem smoothing).
    const eT = clamp01(this.audioFrame.energy);
    const lT = clamp01(this.audioFrame.low);
    const mT = clamp01(this.audioFrame.mid);
    const hT = clamp01(this.audioFrame.high);
    const iT = clamp01(this.audioFrame.impact01);

    const energy = this.smoothAR(this.smEnergy, eT, this.fxAttackHz, this.fxReleaseHz, dt);
    const low = this.smoothAR(this.smLow, lT, this.fxAttackHz, this.fxReleaseHz, dt);
    const mid = this.smoothAR(this.smMid, mT, this.fxAttackHz, this.fxReleaseHz, dt);
    const high = this.smoothAR(this.smHigh, hT, this.fxAttackHz, this.fxReleaseHz, dt);
    const impact = this.smoothAR(this.smImpact, iT, 18, 10, dt);

    this.smEnergy = energy;
    this.smLow = low;
    this.smMid = mid;
    this.smHigh = high;
    this.smImpact = impact;

    this.smQuiet = Boolean(this.audioFrame.quiet);

    // Gust is “impacty” for wind-driven things (dust/leaves).
    const gustTarget = clamp01(impact * 1.25);
    this.gust01 = this.smoothAR(this.gust01, gustTarget, this.gustAttackHz, this.gustReleaseHz, dt);
  }

  /**
   * Returns a multiplier [0..1.25ish] used to scale the strength passed to emitters.
   * - 0 means effectively off (very light)
   * - 1 means full intensity
   */
  private getAudioIntensityMul(mode: ResolvedMode, dt: number): number {
    // No audio yet? behave like old system.
    if (!this.hasAudioFrame) return 1;

    // Stars should not be driven by music energy here (that’s handled elsewhere).
    if (mode === "stars") return 1;

    const e = clamp01(this.smEnergy);
    const low = clamp01(this.smLow);
    const mid = clamp01(this.smMid);
    const high = clamp01(this.smHigh);
    const impact = clamp01(this.smImpact);
    const gust = clamp01(this.gust01);

    // A general “light->heavy” curve. These edges are intentionally low
    // so quiet music still yields subtle motion.
    const baseLight = smoothstep01(0.03, 0.22, e); // first visible motion
    const baseHeavy = smoothstep01(0.25, 0.78, e); // ramps to full

    // We keep a tiny minimum so the world never looks “stuck” while active.
    const tiny = 0.06;

    if (mode === "rain") {
      // Rain reads best as steady. Let energy control density/speed via strength.
      const t = smoothstep01(0.04, 0.62, e);
      return clamp01(tiny + t * 0.94);
    }

    if (mode === "snow") {
      // Snow feels calmer; slightly less “heavy” than rain at peak energy.
      const t = smoothstep01(0.03, 0.58, e);
      return clamp01(tiny + t * 0.88);
    }

    if (mode === "embers") {
      // Embers like mids/highs and a little impact “heat”.
      const emberEnergy = clamp01(mid * 0.72 + high * 0.28);
      const t = smoothstep01(0.03, 0.65, emberEnergy);
      const heatKick = 1 + impact * 0.28;
      return clamp01((tiny + t * 0.94) * heatKick);
    }

    if (mode === "dust") {
      // Dust is wind. Let low/mid and gust control it.
      const windEnergy = clamp01(low * 0.55 + mid * 0.45);
      const t = smoothstep01(0.02, 0.55, windEnergy);
      const gustKick = 1 + gust * 0.75;
      return clamp01((tiny + t * 0.90) * gustKick);
    }

    if (mode === "leaves") {
      // Leaves: mostly wind (low) plus gust.
      const leafEnergy = clamp01(low * 0.72 + mid * 0.28);
      const t = smoothstep01(0.02, 0.58, leafEnergy);
      const gustKick = 1 + gust * 0.65;
      return clamp01((tiny + t * 0.92) * gustKick);
    }

    if (mode === "fireflies") {
      // Fireflies: gentle presence. Prefer being visible even when quiet, but not frantic.
      // If AudioSystem flags quiet, soften them a bit (more sparse feel).
      const t = lerp(baseLight, baseHeavy, 0.55);
      const quietMul = this.smQuiet ? 0.78 : 1.0;
      return clamp01((0.10 + t * 0.85) * quietMul);
    }

    return clamp01(tiny + lerp(baseLight, baseHeavy, 0.65) * 0.94);
  }

  private smoothAR(current: number, target: number, attackHz: number, releaseHz: number, dt: number): number {
    const a = Math.max(0, attackHz);
    const r = Math.max(0, releaseHz);
    const rate = target > current ? a : r;
    if (rate <= 0) return target;

    const k = 1 - Math.exp(-rate * Math.max(0.000001, dt));
    const out = current + (target - current) * k;
    return Number.isFinite(out) ? out : target;
  }
}