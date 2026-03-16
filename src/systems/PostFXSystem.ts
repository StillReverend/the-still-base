// src/systems/PostFXSystem.ts
// ============================================================
// THE STILL — PostFXSystem (robust + CoreSystem-compatible)
// ------------------------------------------------------------
// Key hardening vs “flash”:
//  - Force opaque clear baseline (black, alpha=1) every render
//  - Never rely on DOM background (alpha canvas) for stability
//  - Guard all numeric settings against non-finite values
//
// Audio-reactive bloom (Feb 2026):
//  - Optional setAudioEnergy(0..1) input (impact-style recommended)
//  - Optional impulse channel (gong / ritual pop / scripted events)
//  - Optional ritual charge (0..1 ramp while holding)
//
// Debug tools (Feb 2026):
//  - Max Bloom Mode: bypasses audio mapping + clamps, pins bloom to extreme values
//  - Bloom Telemetry: throttled logging of audio + swell + applied bloom params
//
// Patch (Feb 2026):
//  - Add audio RX counters + ageMs to telemetry to confirm event flow.
//
// Harmony integration (Feb 2026):
//  - setHarmonyEnvironment({ filterId, colorId }) for HarmonyEnvironmentSystem
//  - filterId maps to PostFX profiles (colorId stored for future tinting)
//  - colorId drives a subtle final color tint pass
//
// Patch (Mar 2026):
//  - Removed all LUMEN profile support (lumen, lumen1..4) per project direction.
//    Any legacy filterIds for those profiles now fall back to "default".
//
// Patch (Mar 2026 - Profile cleanup):
//  - Canonical profile names ONLY (no alias family):
//      "default" | "blackHole" | "sol" | "luna" | "off"
//  - Removed "void" profile.
//  - Removed PostFXProfileName "string" escape hatch.
//  - setProfile() now falls back loudly to "default" if an unknown name arrives at runtime.
// ============================================================

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

import type { EventBus } from "../core/EventBus";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/**
 * Canonical, strict PostFX profiles.
 * No aliases, no "string" escape hatch.
 *
 * If something tries to call setProfile("solar"), TypeScript should catch it.
 * If garbage still arrives at runtime (JS), setProfile will fall back loudly.
 */
export type PostFXProfileName = "default" | "blackHole" | "sol" | "luna" | "off";

export interface BloomSettings {
  enabled: boolean;
  strength: number;
  radius: number; // 0..1
  threshold: number; // 0..1
}

export interface StabilitySettings {
  dtClampSeconds: number;
  bloomAttack: number;
  bloomRelease: number;
  resizeIgnorePxJitter: number;
  maxBloomStrength: number;
  stabilizationFrames: number;
  primeFrames: number;
}

export interface PostFXSettings {
  enabled: boolean;
  bloom: BloomSettings;
  stability: StabilitySettings;
  activeProfile?: PostFXProfileName;
}

export interface PostFXProfile {
  name: PostFXProfileName;
  enabled?: boolean;
  bloom?: Partial<BloomSettings>;
  stability?: Partial<StabilitySettings>;
}

export interface PostFXDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  width: number;
  height: number;
  pixelRatio: number;

  // Optional event bus for decoupled driving (recommended)
  bus?: EventBus;

  settings?: Partial<PostFXSettings> & {
    enabled?: boolean;
    bloom?: Partial<BloomSettings>;
  };

  profiles?: PostFXProfile[];
}

// Event payloads (decoupled, flexible)
export interface PostFXAudioEnergyPayload {
  /** 0..1 "impact" energy. Recommended: peaks/transients, not UI. */
  impact01: number;
  /** Optional: flavor if you ever want it later (does NOT need to be used yet). */
  low01?: number;
  mid01?: number;
  high01?: number;
}

export interface PostFXImpulsePayload {
  /** 0..1 impulse amount; 1 is "big cosmic punch". */
  amount01: number;
}

export interface PostFXRitualPayload {
  /** 0..1 ritual hold charge (ramps as you hold). */
  charge01: number;
}

// Debug controls via bus (optional)
export interface PostFXDebugMaxBloomPayload {
  enabled: boolean;
  /** If provided, overrides internal default. */
  strength?: number;
  /** 0..1 */
  radius?: number;
  /** 0..1 */
  threshold?: number;
}

export interface PostFXDebugTelemetryPayload {
  enabled: boolean;
  /** log rate (Hz). default: 6 */
  hz?: number;
}

// Harmony (Environment) payload (called directly, no bus required)
export interface PostFXHarmonyEnvironmentPayload {
  filterId: string;
  colorId: string;
}

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

const isFiniteNumber = (v: number): boolean => Number.isFinite(v) && !Number.isNaN(v);

const n = (v: number, fallback: number): number => (isFiniteNumber(v) ? v : fallback);

const expSmooth = (current: number, target: number, speed: number, dt: number): number => {
  const s = Math.max(0, speed);
  const k = 1 - Math.exp(-s * dt);
  return current + (target - current) * k;
};

const deepMergeSettings = (base: PostFXSettings, patch?: Partial<PostFXSettings>): PostFXSettings => {
  if (!patch) return base;

  return {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : base.enabled,
    bloom: {
      enabled: patch.bloom?.enabled ?? base.bloom.enabled,
      strength: patch.bloom?.strength ?? base.bloom.strength,
      radius: patch.bloom?.radius ?? base.bloom.radius,
      threshold: patch.bloom?.threshold ?? base.bloom.threshold,
    },
    stability: {
      dtClampSeconds: patch.stability?.dtClampSeconds ?? base.stability.dtClampSeconds,
      bloomAttack: patch.stability?.bloomAttack ?? base.stability.bloomAttack,
      bloomRelease: patch.stability?.bloomRelease ?? base.stability.bloomRelease,
      resizeIgnorePxJitter: patch.stability?.resizeIgnorePxJitter ?? base.stability.resizeIgnorePxJitter,
      maxBloomStrength: patch.stability?.maxBloomStrength ?? base.stability.maxBloomStrength,
      stabilizationFrames: patch.stability?.stabilizationFrames ?? base.stability.stabilizationFrames,
      primeFrames: patch.stability?.primeFrames ?? base.stability.primeFrames,
    },
    activeProfile: patch.activeProfile ?? base.activeProfile,
  };
};

// ------------------------------------------------------------
// Canonical Harmony filter mapping -> canonical profiles
// ------------------------------------------------------------

const mapHarmonyFilterToProfile = (filterId: string): PostFXProfileName => {
  const id = String(filterId || "").toLowerCase().trim();

  switch (id) {
    case "f2":
      return "blackHole";
    case "f3":
      return "sol";
    case "f4":
      return "luna";

    // Legacy LUMEN ids (removed): safe fallback
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "l1":
    case "l2":
    case "l3":
    case "l4":
    case "lumen":
    case "lumen1":
    case "lumen2":
    case "lumen3":
    case "lumen4":
      return "default";

    case "f0":
    case "off":
      return "off";

    case "f1":
    default:
      return "default";
  }
};

// Harmony color mapping (subtle, non-cheesy)
const mapHarmonyColorToTint = (colorId: string): { tint: THREE.Color; amount: number } => {
  switch (String(colorId || "").toLowerCase()) {
    case "c1":
    default:
      return { tint: new THREE.Color(0xffe4b5), amount: 0.10 }; // warm wheat
    case "c2":
      return { tint: new THREE.Color(0xa7d8ff), amount: 0.10 };
    case "c3":
      return { tint: new THREE.Color(0xd3a7ff), amount: 0.10 };
    case "c4":
      return { tint: new THREE.Color(0xffb08a), amount: 0.10 };
  }
};

const mapFilterToTintBias = (filterId: string): number => {
  const id = String(filterId || "").toLowerCase().trim();

  switch (id) {
    case "f2":
      return 0.06;
    case "f3":
      return 0.12;
    case "f4":
      return 0.08;

    // Legacy LUMEN family (removed): treat as default
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "l1":
    case "l2":
    case "l3":
    case "l4":
    case "lumen":
    case "lumen1":
    case "lumen2":
    case "lumen3":
    case "lumen4":
      return 0.08;

    case "f1":
    default:
      return 0.08;
  }
};

// ------------------------------------------------------------
// Defaults
// ------------------------------------------------------------

const DEFAULT_SETTINGS: PostFXSettings = {
  enabled: true,
  bloom: {
    enabled: true,
    strength: 0.5,
    radius: 1.0,
    threshold: 0.01,
  },
  stability: {
    dtClampSeconds: 1 / 30,
    bloomAttack: 12,
    bloomRelease: 6,
    resizeIgnorePxJitter: 1,

    // Important: needs to be >= strongest profile strength (sol=5)
    maxBloomStrength: 12,

    stabilizationFrames: 3,
    primeFrames: 2,
  },
  activeProfile: "default",
};

const DEFAULT_PROFILES: PostFXProfile[] = [
  {
    name: "default",
    enabled: true,
    bloom: {
      enabled: DEFAULT_SETTINGS.bloom.enabled,
      strength: DEFAULT_SETTINGS.bloom.strength,
      radius: DEFAULT_SETTINGS.bloom.radius,
      threshold: DEFAULT_SETTINGS.bloom.threshold,
    },
    stability: { ...DEFAULT_SETTINGS.stability },
  },

  { name: "blackHole", enabled: true, bloom: { enabled: true, strength: 1.2, radius: 0.31, threshold: 0.79 } },
  { name: "sol",  enabled: true, bloom: { enabled: true, strength: 1.4, radius: 0.22, threshold: 0.60 } },
  { name: "luna", enabled: true, bloom: { enabled: true, strength: 1.1, radius: 0.35, threshold: 0.55 } },
];

// ------------------------------------------------------------
// PostFXSystem
// ------------------------------------------------------------

export class PostFXSystem {
  private readonly renderer: THREE.WebGLRenderer;

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;

  private harmonyTintPass: ShaderPass;

  private outputPass: OutputPass;

  private settings: PostFXSettings;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  private bloomStrengthCurrent = 0;
  private bloomStrengthTarget = 0;

  private bloomRadiusCurrent = 0;
  private bloomRadiusTarget = 0;

  private targetScene: THREE.Scene;
  private targetCamera: THREE.Camera;

  private profiles: Map<PostFXProfileName, PostFXProfile>;

  private readonly debugEnabled: boolean;
  private lastLoggedBloomTarget = -999;

  private framesToStabilize = 0;
  private primeRendersRemaining = 0;

  private readonly opaqueClearColor = new THREE.Color(0x000000);

  private harmonyColorId = "c1";
  private harmonyFilterId = "f1";

  private audioEnergyCurrent = 0;
  private audioEnergyTarget = 0;

  private audioEnergyRxCount = 0;
  private audioEnergyLastRxMs = -1;

  private impulseCurrent = 0;
  private impulseTarget = 0;

  private ritualChargeCurrent = 0;
  private ritualChargeTarget = 0;

  private quietStrength = 0.08;
  private quietRadius = 0.04;

  private intensityFloor = 0.05;
  private intensityPow = 1.0;

  private swellToMaxStrength01 = 1.0;
  private swellToMaxRadius01 = 1.0;

  private quietEnergyCutoff = 0.001;
  private minBloomWhenPlaying01 = 0.0;

  private impulseGain = 1.35;
  private ritualGain = 1.85;

  private debugMaxBloomEnabled = false;

  private debugMaxBloomStrength = 30.0;
  private debugMaxBloomRadius = 1.0;
  private debugMaxBloomThreshold = 0.0;

  private debugTelemetryEnabled = false;
  private debugTelemetryHz = 6;
  private debugTelemetryAcc = 0;

  private bus: EventBus | null = null;

  private readonly onAudioEnergyEvent = (payload: PostFXAudioEnergyPayload): void => {
    this.audioEnergyRxCount += 1;
    this.audioEnergyLastRxMs = performance.now();
    this.setAudioEnergy(payload?.impact01 ?? 0);
  };

  private readonly onImpulseEvent = (payload: PostFXImpulsePayload): void => {
    this.addImpulse(payload?.amount01 ?? 0);
  };

  private readonly onRitualEvent = (payload: PostFXRitualPayload): void => {
    this.setRitualCharge(payload?.charge01 ?? 0);
  };

  private readonly onDebugMaxBloomEvent = (payload: PostFXDebugMaxBloomPayload): void => {
    const enabled = !!payload?.enabled;
    this.setDebugMaxBloomEnabled(enabled, {
      strength: payload?.strength,
      radius: payload?.radius,
      threshold: payload?.threshold,
    });
  };

  private readonly onDebugTelemetryEvent = (payload: PostFXDebugTelemetryPayload): void => {
    const enabled = !!payload?.enabled;
    const hz = payload?.hz;
    this.setDebugTelemetryEnabled(enabled, hz);
  };

  constructor(deps: PostFXDeps) {
    this.renderer = deps.renderer;

    this.width = Math.max(1, Math.floor(deps.width));
    this.height = Math.max(1, Math.floor(deps.height));
    this.pixelRatio = Math.max(1, deps.pixelRatio);

    this.targetScene = deps.scene;
    this.targetCamera = deps.camera;

    this.settings = deepMergeSettings(DEFAULT_SETTINGS, deps.settings);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.debugEnabled = typeof import.meta !== "undefined" ? Boolean((import.meta as any).env?.DEV) : false;

    const allProfiles = [...DEFAULT_PROFILES, ...(deps.profiles ?? [])];
    this.profiles = new Map(allProfiles.map((p) => [p.name, p] as const));

    if (deps.bus) {
      this.bus = deps.bus;

      this.bus.on<PostFXAudioEnergyPayload>(
        "postfx:audio-energy",
        this.onAudioEnergyEvent as unknown as (p: unknown) => void,
      );
      this.bus.on<PostFXImpulsePayload>("postfx:impulse", this.onImpulseEvent as unknown as (p: unknown) => void);
      this.bus.on<PostFXRitualPayload>("postfx:ritual", this.onRitualEvent as unknown as (p: unknown) => void);

      this.bus.on<PostFXDebugMaxBloomPayload>(
        "postfx:debug-max-bloom",
        this.onDebugMaxBloomEvent as unknown as (p: unknown) => void,
      );
      this.bus.on<PostFXDebugTelemetryPayload>(
        "postfx:debug-telemetry",
        this.onDebugTelemetryEvent as unknown as (p: unknown) => void,
      );
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(this.targetScene, this.targetCamera);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.0,
      clamp01(this.settings.bloom.radius),
      clamp01(this.settings.bloom.threshold),
    );
    this.bloomPass.enabled = true;

    this.harmonyTintPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uAmount: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec3 uTint;
        uniform float uAmount;
        varying vec2 vUv;

        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          vec3 tinted = col.rgb * uTint;
          col.rgb = mix(col.rgb, tinted, clamp(uAmount, 0.0, 1.0));
          gl_FragColor = col;
        }
      `,
    });

    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.harmonyTintPass);
    this.composer.addPass(this.outputPass);

    this.syncBloomStaticParams();
    this.setBloomEnabled(this.settings.bloom.enabled, true);
    this.setEnabled(this.settings.enabled, true);

    this.bloomStrengthCurrent = 0;
    this.bloomStrengthTarget = 0;
    this.bloomRadiusCurrent = clamp01(n(this.settings.bloom.radius, DEFAULT_SETTINGS.bloom.radius));
    this.bloomRadiusTarget = this.bloomRadiusCurrent;
    this.bloomPass.radius = this.bloomRadiusCurrent;

    this.applyHarmonyTint(this.harmonyColorId, this.harmonyFilterId);

    this.resize(this.width, this.height, this.pixelRatio);
  }

  // ------------------------------------------------------------
  // Harmony integration (called by HarmonyEnvironmentSystem)
  // ------------------------------------------------------------

  public setHarmonyEnvironment(payload: PostFXHarmonyEnvironmentPayload): void {
    const filterId = typeof payload?.filterId === "string" ? payload.filterId : "f1";
    const colorId = typeof payload?.colorId === "string" ? payload.colorId : "c1";

    const nextProfile = mapHarmonyFilterToProfile(filterId);

    this.harmonyFilterId = filterId;
    this.harmonyColorId = colorId;

    this.applyHarmonyTint(this.harmonyColorId, this.harmonyFilterId);

    if (nextProfile === "off") {
      this.setEnabled(false);
      return;
    }

    this.setEnabled(true);
    this.setProfile(nextProfile);
  }

  public getHarmonyEnvironment(): { filterId: string; colorId: string } {
    return { filterId: this.harmonyFilterId, colorId: this.harmonyColorId };
  }

  // ------------------------------------------------------------
  // Public debug API (also reachable via EventBus)
  // ------------------------------------------------------------

  public setDebugMaxBloomEnabled(
    enabled: boolean,
    opts?: { strength?: number; radius?: number; threshold?: number },
  ): void {
    this.debugMaxBloomEnabled = !!enabled;

    if (isFiniteNumber(opts?.strength as number)) this.debugMaxBloomStrength = Math.max(0, opts!.strength as number);
    if (isFiniteNumber(opts?.radius as number)) this.debugMaxBloomRadius = clamp01(opts!.radius as number);
    if (isFiniteNumber(opts?.threshold as number)) this.debugMaxBloomThreshold = clamp01(opts!.threshold as number);

    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(
        `[PostFX] DebugMaxBloom ${this.debugMaxBloomEnabled ? "ENABLED" : "DISABLED"} ` +
          `(str=${this.debugMaxBloomStrength.toFixed(2)} rad=${this.debugMaxBloomRadius.toFixed(
            2,
          )} thr=${this.debugMaxBloomThreshold.toFixed(3)})`,
      );
    }

    if (this.debugMaxBloomEnabled) {
      this.bloomPass.threshold = this.debugMaxBloomThreshold;
      this.framesToStabilize = Math.max(1, this.framesToStabilize);
    } else {
      this.syncBloomStaticParams();
    }
  }

  public setDebugTelemetryEnabled(enabled: boolean, hz?: number): void {
    this.debugTelemetryEnabled = !!enabled;
    if (isFiniteNumber(hz as number)) this.debugTelemetryHz = clamp(hz as number, 0.2, 60);

    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(
        `[PostFX] DebugTelemetry ${this.debugTelemetryEnabled ? "ENABLED" : "DISABLED"} hz=${this.debugTelemetryHz}`,
      );
    }

    this.debugTelemetryAcc = 0;
  }

  public setQuietEnergyCutoff(v: number): void {
    this.quietEnergyCutoff = clamp01(isFiniteNumber(v) ? v : this.quietEnergyCutoff);
  }

  public setMinBloomWhenPlaying01(v01: number): void {
    this.minBloomWhenPlaying01 = clamp01(isFiniteNumber(v01) ? v01 : this.minBloomWhenPlaying01);
  }

  public setQuietBloom(strength: number, radius: number): void {
    this.quietStrength = Math.max(0, isFiniteNumber(strength) ? strength : this.quietStrength);
    this.quietRadius = clamp01(isFiniteNumber(radius) ? radius : this.quietRadius);
  }

  public setAudioEnergy(energy01: number): void {
    const e = clamp01(isFiniteNumber(energy01) ? energy01 : 0);
    this.audioEnergyTarget = e;
  }

  public addImpulse(amount01: number): void {
    const a = clamp01(isFiniteNumber(amount01) ? amount01 : 0);
    this.impulseTarget = clamp01(this.impulseTarget + a);
  }

  public setRitualCharge(charge01: number): void {
    const c = clamp01(isFiniteNumber(charge01) ? charge01 : 0);
    this.ritualChargeTarget = c;
  }

  public setProfile(profileName: PostFXProfileName): void {
    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[PostFX] setProfile("${profileName}") @ ${performance.now().toFixed(0)}ms`);
    }

    if (profileName === "off") {
      this.setEnabled(false);
      return;
    }

    // Runtime guard: if JS sends garbage, fall back loudly.
    let resolved: PostFXProfileName = profileName;
    const profile = this.profiles.get(resolved);

    if (!profile) {
      if (this.debugEnabled) {
        // eslint-disable-next-line no-console
        console.error(`[PostFX] Unknown profile '${String(profileName)}'. Falling back to 'default'.`);
      }
      resolved = "default";
    }

    const p = this.profiles.get(resolved);
    if (!p) {
      // This should never happen unless DEFAULT_PROFILES is corrupted.
      if (this.debugEnabled) {
        // eslint-disable-next-line no-console
        console.error("[PostFX] Missing 'default' profile. Disabling PostFX.");
      }
      this.setEnabled(false, true);
      return;
    }

    const next: Partial<PostFXSettings> = {
      enabled: p.enabled ?? this.settings.enabled,
      bloom: p.bloom ? { ...this.settings.bloom, ...p.bloom } : this.settings.bloom,
      stability: p.stability ? { ...this.settings.stability, ...p.stability } : this.settings.stability,
      activeProfile: resolved,
    };

    this.settings = deepMergeSettings(this.settings, next);

    this.settings.bloom.strength = n(this.settings.bloom.strength, DEFAULT_SETTINGS.bloom.strength);
    this.settings.bloom.radius = n(this.settings.bloom.radius, DEFAULT_SETTINGS.bloom.radius);
    this.settings.bloom.threshold = n(this.settings.bloom.threshold, DEFAULT_SETTINGS.bloom.threshold);

    this.settings.stability.dtClampSeconds = n(
      this.settings.stability.dtClampSeconds,
      DEFAULT_SETTINGS.stability.dtClampSeconds,
    );
    this.settings.stability.bloomAttack = n(this.settings.stability.bloomAttack, DEFAULT_SETTINGS.stability.bloomAttack);
    this.settings.stability.bloomRelease = n(
      this.settings.stability.bloomRelease,
      DEFAULT_SETTINGS.stability.bloomRelease,
    );
    this.settings.stability.maxBloomStrength = n(
      this.settings.stability.maxBloomStrength,
      DEFAULT_SETTINGS.stability.maxBloomStrength,
    );

    this.syncBloomStaticParams();
    this.setEnabled(this.settings.enabled);
    this.setBloomEnabled(this.settings.bloom.enabled);

    if (this.debugMaxBloomEnabled) {
      this.bloomPass.threshold = this.debugMaxBloomThreshold;
    }
  }

  public getSettings(): PostFXSettings {
    return {
      enabled: this.settings.enabled,
      bloom: { ...this.settings.bloom },
      stability: { ...this.settings.stability },
      activeProfile: this.settings.activeProfile,
    };
  }

  public setTargets(scene: THREE.Scene, camera: THREE.Camera): void {
    this.targetScene = scene;
    this.targetCamera = camera;
    this.renderPass.scene = this.targetScene;
    this.renderPass.camera = this.targetCamera;
  }

  public setEnabled(enabled: boolean, instant = false): void {
    this.settings.enabled = enabled;

    const base = this.settings.enabled && this.settings.bloom.enabled ? n(this.settings.bloom.strength, 0) : 0;
    this.bloomStrengthTarget = Math.max(0, base);

    if (instant) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomPass.strength = this.bloomStrengthCurrent;
    }
  }

  public setBloomEnabled(enabled: boolean, instant = false): void {
    this.settings.bloom.enabled = enabled;

    const base = this.settings.enabled && enabled ? n(this.settings.bloom.strength, 0) : 0;
    this.bloomStrengthTarget = Math.max(0, base);

    if (instant) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomPass.strength = this.bloomStrengthCurrent;
    }
  }

  public update(dtSeconds: number): void {
    const st = this.settings.stability;

    const dtSafe = isFiniteNumber(dtSeconds) ? dtSeconds : 0;
    const dtClamp = Math.max(1 / 120, n(st.dtClampSeconds, DEFAULT_SETTINGS.stability.dtClampSeconds));
    const dt = clamp(dtSafe, 0, dtClamp);

    if (!this.debugMaxBloomEnabled) {
      this.syncBloomStaticParams();
    } else {
      this.bloomPass.threshold = this.debugMaxBloomThreshold;
    }

    if (this.debugMaxBloomEnabled) {
      const targetStr = Math.max(0, this.debugMaxBloomStrength);
      const targetRad = clamp01(this.debugMaxBloomRadius);

      this.bloomStrengthTarget = targetStr;
      this.bloomRadiusTarget = targetRad;

      if (this.framesToStabilize > 0) {
        this.bloomStrengthCurrent = this.bloomStrengthTarget;
        this.bloomRadiusCurrent = this.bloomRadiusTarget;

        this.bloomPass.strength = this.bloomStrengthCurrent;
        this.bloomPass.radius = this.bloomRadiusCurrent;

        this.framesToStabilize -= 1;
        this.maybeTelemetryLog(dt, {
          quiet: false,
          swell01: 1,
          impulseBoost: 0,
          ritualBoost: 0,
          maxStrengthBase: targetStr,
          maxRadiusBase: targetRad,
          strengthFromAudio: targetStr,
        });
        return;
      }

      const attack = n(st.bloomAttack, DEFAULT_SETTINGS.stability.bloomAttack);
      const release = n(st.bloomRelease, DEFAULT_SETTINGS.stability.bloomRelease);

      const speedStr = this.bloomStrengthTarget > this.bloomStrengthCurrent ? attack : release;
      this.bloomStrengthCurrent = expSmooth(this.bloomStrengthCurrent, this.bloomStrengthTarget, speedStr, dt);

      const speedRad = this.bloomRadiusTarget > this.bloomRadiusCurrent ? attack : release;
      this.bloomRadiusCurrent = expSmooth(this.bloomRadiusCurrent, this.bloomRadiusTarget, speedRad, dt);

      if (!isFiniteNumber(this.bloomStrengthCurrent)) this.bloomStrengthCurrent = 0;
      if (!isFiniteNumber(this.bloomRadiusCurrent)) this.bloomRadiusCurrent = 0;

      this.bloomPass.strength = this.bloomStrengthCurrent;
      this.bloomPass.radius = this.bloomRadiusCurrent;

      this.maybeTelemetryLog(dt, {
        quiet: false,
        swell01: 1,
        impulseBoost: 0,
        ritualBoost: 0,
        maxStrengthBase: targetStr,
        maxRadiusBase: targetRad,
        strengthFromAudio: targetStr,
      });

      return;
    }

    const maxStrengthBase =
      this.settings.enabled && this.settings.bloom.enabled
        ? Math.max(0, n(this.settings.bloom.strength, DEFAULT_SETTINGS.bloom.strength))
        : 0;

    const maxRadiusBase =
      this.settings.enabled && this.settings.bloom.enabled
        ? clamp01(n(this.settings.bloom.radius, DEFAULT_SETTINGS.bloom.radius))
        : 0;

    const attackE = Math.max(0, n(st.bloomAttack, DEFAULT_SETTINGS.stability.bloomAttack)) * 1.65;
    const releaseE = Math.max(0, n(st.bloomRelease, DEFAULT_SETTINGS.stability.bloomRelease)) * 1.05;
    const speedE = this.audioEnergyTarget > this.audioEnergyCurrent ? attackE : releaseE;

    this.audioEnergyCurrent = expSmooth(this.audioEnergyCurrent, this.audioEnergyTarget, speedE, dt);
    if (!isFiniteNumber(this.audioEnergyCurrent)) this.audioEnergyCurrent = 0;

    const quiet = this.audioEnergyTarget <= this.quietEnergyCutoff;

    const gated = clamp01(
      (this.audioEnergyCurrent - this.intensityFloor) / Math.max(0.0001, 1 - this.intensityFloor),
    );

    const shaped = Math.pow(gated, Math.max(0.01, this.intensityPow));
    const swell01Raw = clamp01(shaped);

    const swell01 = quiet ? 0 : Math.max(this.minBloomWhenPlaying01, swell01Raw);

    const impulseAttack = 40;
    const impulseRelease = 10;
    const impulseSpeed = this.impulseTarget > this.impulseCurrent ? impulseAttack : impulseRelease;

    this.impulseCurrent = expSmooth(this.impulseCurrent, this.impulseTarget, impulseSpeed, dt);
    if (!isFiniteNumber(this.impulseCurrent)) this.impulseCurrent = 0;

    this.impulseTarget = expSmooth(this.impulseTarget, 0, 16, dt);
    if (!isFiniteNumber(this.impulseTarget)) this.impulseTarget = 0;

    const impulseBoost = clamp01(this.impulseCurrent) * this.impulseGain;

    const ritualAttack = 8;
    const ritualRelease = 10;
    const ritualSpeed = this.ritualChargeTarget > this.ritualChargeCurrent ? ritualAttack : ritualRelease;

    this.ritualChargeCurrent = expSmooth(this.ritualChargeCurrent, this.ritualChargeTarget, ritualSpeed, dt);
    if (!isFiniteNumber(this.ritualChargeCurrent)) this.ritualChargeCurrent = 0;

    const ritualCurve = clamp01(Math.pow(clamp01(this.ritualChargeCurrent), 2.2));
    const ritualBoost = ritualCurve * this.ritualGain;

    const strengthFloor = Math.max(0, this.quietStrength);
    const strengthHot = maxStrengthBase;

    const strengthFromAudio =
      strengthFloor + (strengthHot - strengthFloor) * clamp01(swell01) * this.swellToMaxStrength01;

    const maxStrength = Math.max(0.0, n(st.maxBloomStrength, DEFAULT_SETTINGS.stability.maxBloomStrength));
    this.bloomStrengthTarget = clamp(strengthFromAudio + impulseBoost + ritualBoost, 0, maxStrength);

    const radiusFloor = clamp01(this.quietRadius);
    const radiusHot = maxRadiusBase;

    this.bloomRadiusTarget = clamp01(
      radiusFloor + (radiusHot - radiusFloor) * clamp01(swell01) * this.swellToMaxRadius01,
    );

    if (this.debugEnabled && Math.abs(this.bloomStrengthTarget - this.lastLoggedBloomTarget) > 0.15) {
      this.lastLoggedBloomTarget = this.bloomStrengthTarget;
      // eslint-disable-next-line no-console
      console.log(
        `[PostFX] target(str=${this.bloomStrengthTarget.toFixed(3)} rad=${this.bloomRadiusTarget.toFixed(
          3,
        )}) current(str=${this.bloomStrengthCurrent.toFixed(3)} rad=${this.bloomRadiusCurrent.toFixed(
          3,
        )}) swell01=${swell01.toFixed(3)} quiet=${quiet ? "Y" : "N"} cutoff=${this.quietEnergyCutoff.toFixed(
          4,
        )} floor=${this.intensityFloor.toFixed(3)} pow=${this.intensityPow.toFixed(
          2,
        )} minPlay=${this.minBloomWhenPlaying01.toFixed(3)} profile=${this.settings.activeProfile ?? "?"} @ ${performance.now().toFixed(
          0,
        )}ms`,
      );
    }

    if (this.framesToStabilize > 0) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomRadiusCurrent = this.bloomRadiusTarget;

      this.bloomPass.strength = this.bloomStrengthCurrent;
      this.bloomPass.radius = this.bloomRadiusCurrent;

      this.framesToStabilize -= 1;

      this.maybeTelemetryLog(dt, {
        quiet,
        swell01,
        impulseBoost,
        ritualBoost,
        maxStrengthBase,
        maxRadiusBase,
        strengthFromAudio,
      });

      return;
    }

    const attack = n(st.bloomAttack, DEFAULT_SETTINGS.stability.bloomAttack);
    const release = n(st.bloomRelease, DEFAULT_SETTINGS.stability.bloomRelease);

    const speedStr = this.bloomStrengthTarget > this.bloomStrengthCurrent ? attack : release;
    this.bloomStrengthCurrent = expSmooth(this.bloomStrengthCurrent, this.bloomStrengthTarget, speedStr, dt);

    if (!isFiniteNumber(this.bloomStrengthCurrent)) {
      if (this.debugEnabled) {
        // eslint-disable-next-line no-console
        console.error("[PostFX] bloomStrengthCurrent became non-finite. Forcing to 0.", this.bloomStrengthCurrent);
      }
      this.bloomStrengthCurrent = 0;
      this.bloomStrengthTarget = 0;
    }

    const speedRad = this.bloomRadiusTarget > this.bloomRadiusCurrent ? attack : release;
    this.bloomRadiusCurrent = expSmooth(this.bloomRadiusCurrent, this.bloomRadiusTarget, speedRad, dt);

    if (!isFiniteNumber(this.bloomRadiusCurrent)) {
      if (this.debugEnabled) {
        // eslint-disable-next-line no-console
        console.error("[PostFX] bloomRadiusCurrent became non-finite. Forcing to 0.", this.bloomRadiusCurrent);
      }
      this.bloomRadiusCurrent = 0;
      this.bloomRadiusTarget = 0;
    }

    this.bloomPass.strength = this.bloomStrengthCurrent;
    this.bloomPass.radius = this.bloomRadiusCurrent;

    this.maybeTelemetryLog(dt, {
      quiet,
      swell01,
      impulseBoost,
      ritualBoost,
      maxStrengthBase,
      maxRadiusBase,
      strengthFromAudio,
    });
  }

  public render(): void {
    this.renderer.autoClear = true;
    this.renderer.setClearColor(this.opaqueClearColor, 1.0);
    this.renderer.clear(true, true, true);

    if (this.primeRendersRemaining > 0) {
      this.primeRendersRemaining -= 1;

      const savedStr = this.bloomPass.strength;
      const savedRad = this.bloomPass.radius;
      const savedThr = this.bloomPass.threshold;

      this.bloomPass.strength = 0;
      this.bloomPass.radius = 0;
      this.bloomPass.threshold = 1;
      this.composer.render();

      this.bloomPass.strength = savedStr;
      this.bloomPass.radius = savedRad;
      this.bloomPass.threshold = savedThr;

      this.renderer.setClearColor(this.opaqueClearColor, 1.0);
      this.renderer.clear(true, true, true);
    }

    this.composer.render();
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const pr = Math.max(1, pixelRatio);

    const ignore = Math.max(
      0,
      n(this.settings.stability.resizeIgnorePxJitter, DEFAULT_SETTINGS.stability.resizeIgnorePxJitter),
    );

    const prChanged = Math.abs(pr - this.pixelRatio) > 0.001;
    const wChanged = Math.abs(w - this.width) > ignore;
    const hChanged = Math.abs(h - this.height) > ignore;

    if (!prChanged && !wChanged && !hChanged) return;

    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[PostFX] resize -> ${w}x${h} pr=${pr.toFixed(2)} @ ${performance.now().toFixed(0)}ms`);
    }

    this.width = w;
    this.height = h;
    this.pixelRatio = pr;

    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width, this.height);

    this.framesToStabilize = Math.max(
      0,
      n(this.settings.stability.stabilizationFrames, DEFAULT_SETTINGS.stability.stabilizationFrames),
    );
    this.primeRendersRemaining = Math.max(
      0,
      n(this.settings.stability.primeFrames, DEFAULT_SETTINGS.stability.primeFrames),
    );
  }

  public dispose(): void {
    if (this.bus) {
      this.bus.off("postfx:audio-energy", this.onAudioEnergyEvent as unknown as (p: unknown) => void);
      this.bus.off("postfx:impulse", this.onImpulseEvent as unknown as (p: unknown) => void);
      this.bus.off("postfx:ritual", this.onRitualEvent as unknown as (p: unknown) => void);

      this.bus.off("postfx:debug-max-bloom", this.onDebugMaxBloomEvent as unknown as (p: unknown) => void);
      this.bus.off("postfx:debug-telemetry", this.onDebugTelemetryEvent as unknown as (p: unknown) => void);

      this.bus = null;
    }

    const anyTint = this.harmonyTintPass as unknown as { material?: { dispose?: () => void } };
    if (anyTint.material && typeof anyTint.material.dispose === "function") {
      anyTint.material.dispose();
    }

    const anyComposer = this.composer as unknown as { dispose?: () => void };
    if (typeof anyComposer.dispose === "function") anyComposer.dispose();
  }

  private syncBloomStaticParams(): void {
    this.bloomPass.threshold = clamp01(n(this.settings.bloom.threshold, DEFAULT_SETTINGS.bloom.threshold));
  }

  private applyHarmonyTint(colorId: string, filterId: string): void {
    const { tint, amount } = mapHarmonyColorToTint(colorId);
    const bias = mapFilterToTintBias(filterId);

    const amt = clamp(amount + bias * 0.5, 0, 0.22);

    const avg = Math.max(1e-6, (tint.r + tint.g + tint.b) / 3);
    let scale = 1 / avg;
    scale = clamp(scale, 0.85, 1.25);

    const tr = clamp(tint.r * scale, 0, 2);
    const tg = clamp(tint.g * scale, 0, 2);
    const tb = clamp(tint.b * scale, 0, 2);

    const u = this.harmonyTintPass.uniforms as unknown as {
      uTint: { value: THREE.Vector3 };
      uAmount: { value: number };
    };

    u.uTint.value.set(tr, tg, tb);
    u.uAmount.value = amt;
  }

  private maybeTelemetryLog(
    dt: number,
    info: {
      quiet: boolean;
      swell01: number;
      impulseBoost: number;
      ritualBoost: number;
      maxStrengthBase: number;
      maxRadiusBase: number;
      strengthFromAudio: number;
    },
  ): void {
    if (!this.debugTelemetryEnabled) return;

    const hz = Math.max(0.2, this.debugTelemetryHz);
    const interval = 1 / hz;

    this.debugTelemetryAcc += Math.max(0, dt);
    if (this.debugTelemetryAcc < interval) return;
    this.debugTelemetryAcc = 0;

    const now = performance.now();
    const ageMs = this.audioEnergyLastRxMs < 0 ? -1 : Math.max(0, now - this.audioEnergyLastRxMs);

    // eslint-disable-next-line no-console
    console.log(
      `[PostFX:telemetry] profile=${this.settings.activeProfile ?? "?"} maxMode=${this.debugMaxBloomEnabled ? "Y" : "N"} ` +
        `rx=${this.audioEnergyRxCount} ageMs=${ageMs < 0 ? "NA" : ageMs.toFixed(0)} ` +
        `E(tgt=${this.audioEnergyTarget.toFixed(3)} cur=${this.audioEnergyCurrent.toFixed(3)}) ` +
        `quiet=${info.quiet ? "Y" : "N"} cutoff=${this.quietEnergyCutoff.toFixed(4)} floor=${this.intensityFloor.toFixed(
          3,
        )} pow=${this.intensityPow.toFixed(2)} ` +
        `swell=${info.swell01.toFixed(3)} minPlay=${this.minBloomWhenPlaying01.toFixed(3)} ` +
        `base(str=${info.maxStrengthBase.toFixed(2)} rad=${info.maxRadiusBase.toFixed(2)}) ` +
        `fromAudio=${info.strengthFromAudio.toFixed(2)} +imp=${info.impulseBoost.toFixed(2)} +rit=${info.ritualBoost.toFixed(
          2,
        )} ` +
        `=> target(str=${this.bloomStrengthTarget.toFixed(2)} rad=${this.bloomRadiusTarget.toFixed(
          2,
        )} thr=${this.bloomPass.threshold.toFixed(3)}) ` +
        `applied(str=${this.bloomPass.strength.toFixed(2)} rad=${this.bloomPass.radius.toFixed(2)})`,
    );
  }
}