// src/systems/PostFXSystem.ts
// ============================================================
// THE STILL — PostFXSystem (robust + CoreSystem-compatible)
// ------------------------------------------------------------
// Required API (used across Engine/Core):
//  - constructor({ renderer, scene, camera, width, height, pixelRatio, settings })
//  - setTargets(scene, camera)
//  - setProfile(profileName)
//  - getSettings()
//  - setEnabled(enabled)
//  - setBloomEnabled(enabled)
//  - update(dtSeconds)
//  - render()
//  - resize(w, h, pr)
//  - dispose()
//
// Design goals:
//  - Rock-solid bloom (no full-screen “flash”)
//  - Never toggle bloom pass: fade strength to 0
//  - Resize guards ignore 1px jitter
//  - Attack/release smoothing + dt clamp
//  - Profiles = stable look switching w/o rebuilding pipeline
//
// Key hardening vs “flash after resize”:
//  1) Enforce renderer state baseline every render (prevents drift from other systems)
//  2) After any real resize, prime render targets (two warmup renders with bloom=0)
//  3) During stabilization frames, snap bloom strength (no smoothing surprise)
// ============================================================

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type PostFXProfileName =
  | "default"
  | "void"
  | "blackHole"
  | "solar"
  | "sun"
  | "lunar"
  | "luna"
  | "moon"
  | "off"
  | string;

export interface BloomSettings {
  enabled: boolean;
  strength: number;
  radius: number; // 0..1
  threshold: number; // 0..1
}

export interface StabilitySettings {
  dtClampSeconds: number; // clamp huge dt spikes (tab focus, hitches)
  bloomAttack: number; // faster ramp-up
  bloomRelease: number; // slower ramp-down
  resizeIgnorePxJitter: number; // ignore +/- N px changes
  maxBloomStrength: number; // safety clamp for bloom target
  stabilizationFrames: number; // frames to snap strength after resize
  primeFrames: number; // warmup renders after resize (bloom=0)
}

export interface PostFXSettings {
  enabled: boolean;
  bloom: BloomSettings;
  stability: StabilitySettings;
  activeProfile?: string;
}

export interface PostFXProfile {
  name: string;
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

  settings?: Partial<PostFXSettings> & {
    enabled?: boolean;
    bloom?: Partial<BloomSettings>;
  };

  profiles?: PostFXProfile[];
}

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const isFiniteNumber = (v: number): boolean => Number.isFinite(v) && !Number.isNaN(v);

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
// Defaults
// ------------------------------------------------------------

const DEFAULT_SETTINGS: PostFXSettings = {
  enabled: true,
  bloom: {
    enabled: true,
    strength: 1.05,
    radius: 0.55,
    threshold: 0.12,
  },
  stability: {
    dtClampSeconds: 1 / 30,
    bloomAttack: 12,
    bloomRelease: 6,
    resizeIgnorePxJitter: 1,
    maxBloomStrength: 3,
    stabilizationFrames: 3,
    primeFrames: 2,
  },
  activeProfile: "default",
};

/**
 * IMPORTANT: match CoreSystem mapping:
 *  - solar -> "solar"
 *  - lunar -> "luna"
 *  - black_hole -> "blackHole"
 *
 * Also keep aliases ("sun","moon","void") so older code won’t break.
 */
const DEFAULT_PROFILES: PostFXProfile[] = [
  {
    name: "default",
    enabled: true,
    bloom: { enabled: true, strength: 1.05, radius: 0.55, threshold: 0.12 },
  },

  // CoreSystem targets:
  {
    name: "solar",
    enabled: true,
    bloom: { enabled: true, strength: 1.25, radius: 0.65, threshold: 0.10 },
  },
  {
    name: "luna",
    enabled: true,
    bloom: { enabled: true, strength: 0.9, radius: 0.5, threshold: 0.18 },
  },
  {
    name: "blackHole",
    enabled: true,
    bloom: { enabled: true, strength: 1.0, radius: 0.6, threshold: 0.14 },
  },

  // Aliases (safe):
  { name: "sun", enabled: true, bloom: { enabled: true, strength: 1.25, radius: 0.65, threshold: 0.10 } },
  { name: "moon", enabled: true, bloom: { enabled: true, strength: 0.9, radius: 0.5, threshold: 0.18 } },
  { name: "void", enabled: true, bloom: { enabled: true, strength: 1.0, radius: 0.6, threshold: 0.14 } },

  { name: "off", enabled: false, bloom: { enabled: false, strength: 0.0, radius: 0.0, threshold: 1.0 } },
];

// ------------------------------------------------------------
// Renderer baseline enforcement (prevents drift-trigger flashes)
// ------------------------------------------------------------

type RendererBaseline = {
  autoClear: boolean;
  clearColor: THREE.Color;
  clearAlpha: number;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputColorSpace?: any;
};

// ------------------------------------------------------------
// PostFXSystem
// ------------------------------------------------------------

export class PostFXSystem {
  private readonly renderer: THREE.WebGLRenderer;

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private outputPass: OutputPass;

  private settings: PostFXSettings;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  // Bloom smoothing
  private bloomStrengthCurrent = 0;
  private bloomStrengthTarget = 0;

  // Targets
  private targetScene: THREE.Scene;
  private targetCamera: THREE.Camera;

  // Profiles
  private profiles: Map<string, PostFXProfile>;

  // Debug tripwires
  private readonly debugEnabled: boolean;
  private lastLoggedBloomTarget = -999;

  // Renderer baseline enforcement
  private baseline: RendererBaseline | null = null;

  // Resize stabilization
  private framesToStabilize = 0;
  private primeRendersRemaining = 0;

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
    this.profiles = new Map(allProfiles.map((p) => [p.name, p]));

    // Composer pipeline (stable, never rebuilt)
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(this.targetScene, this.targetCamera);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.0, // strength set dynamically
      clamp01(this.settings.bloom.radius),
      clamp01(this.settings.bloom.threshold),
    );
    this.bloomPass.enabled = true;

    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);

    // Capture baseline renderer state (what the rest of your app “should” see)
    this.baseline = this.captureBaselineRendererState();

    // Apply initial params
    this.syncBloomStaticParams();
    this.setBloomEnabled(this.settings.bloom.enabled, true);
    this.setEnabled(this.settings.enabled, true);

    // Ensure internal RT sizes are correct
    this.resize(this.width, this.height, this.pixelRatio);
  }

  // ----------------------------------------------------------
  // CoreSystem compatibility
  // ----------------------------------------------------------

  public setProfile(profileName: PostFXProfileName): void {
    if (this.debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[PostFX] setProfile("${profileName}") @ ${performance.now().toFixed(0)}ms`);
    }

    const profile = this.profiles.get(profileName);
    if (!profile) {
      this.settings.activeProfile = profileName;
      return;
    }

    const next: Partial<PostFXSettings> = {
      enabled: profile.enabled ?? this.settings.enabled,
      bloom: profile.bloom ? { ...this.settings.bloom, ...profile.bloom } : this.settings.bloom,
      stability: profile.stability ? { ...this.settings.stability, ...profile.stability } : this.settings.stability,
      activeProfile: profileName,
    };

    this.settings = deepMergeSettings(this.settings, next);

    this.syncBloomStaticParams();
    this.setEnabled(this.settings.enabled);
    this.setBloomEnabled(this.settings.bloom.enabled);
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

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

    const base = this.settings.enabled && this.settings.bloom.enabled ? this.settings.bloom.strength : 0;
    this.bloomStrengthTarget = Math.max(0, base);

    if (instant) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomPass.strength = this.bloomStrengthCurrent;
    }
  }

  public setBloomEnabled(enabled: boolean, instant = false): void {
    this.settings.bloom.enabled = enabled;

    const base = this.settings.enabled && enabled ? this.settings.bloom.strength : 0;
    this.bloomStrengthTarget = Math.max(0, base);

    if (instant) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomPass.strength = this.bloomStrengthCurrent;
    }
  }

  public update(dtSeconds: number): void {
    const st = this.settings.stability;

    const dtSafe = isFiniteNumber(dtSeconds) ? dtSeconds : 0;
    const dtClamp = Math.max(1 / 120, st.dtClampSeconds);
    const dt = clamp(dtSafe, 0, dtClamp);

    this.syncBloomStaticParams();

    const base = this.settings.enabled && this.settings.bloom.enabled ? Math.max(0, this.settings.bloom.strength) : 0;
    this.bloomStrengthTarget = clamp(base, 0, Math.max(0.25, st.maxBloomStrength));

    if (this.debugEnabled && Math.abs(this.bloomStrengthTarget - this.lastLoggedBloomTarget) > 0.15) {
      this.lastLoggedBloomTarget = this.bloomStrengthTarget;
      // eslint-disable-next-line no-console
      console.log(
        `[PostFX] bloomTarget=${this.bloomStrengthTarget.toFixed(3)} current=${this.bloomStrengthCurrent.toFixed(
          3,
        )} enabled=${this.settings.enabled} bloomEnabled=${this.settings.bloom.enabled} profile=${
          this.settings.activeProfile ?? "?"
        } @ ${performance.now().toFixed(0)}ms`,
      );
    }

    // After resize, snap strength for a few frames (no smoothing surprises)
    if (this.framesToStabilize > 0) {
      this.bloomStrengthCurrent = this.bloomStrengthTarget;
      this.bloomPass.strength = this.bloomStrengthCurrent;
      this.framesToStabilize -= 1;
      return;
    }

    const speed = this.bloomStrengthTarget > this.bloomStrengthCurrent ? st.bloomAttack : st.bloomRelease;
    this.bloomStrengthCurrent = expSmooth(this.bloomStrengthCurrent, this.bloomStrengthTarget, speed, dt);

    if (!isFiniteNumber(this.bloomStrengthCurrent)) {
      if (this.debugEnabled) {
        // eslint-disable-next-line no-console
        console.error("[PostFX] bloomStrengthCurrent became non-finite. Forcing to 0.", this.bloomStrengthCurrent);
      }
      this.bloomStrengthCurrent = 0;
      this.bloomStrengthTarget = 0;
    }

    this.bloomPass.strength = this.bloomStrengthCurrent;
  }

  public render(): void {
    // 1) Enforce renderer baseline every render (prevents “drift flash”)
    this.applyBaselineRendererState();

    // 2) Prime render targets after resize: render bloom=0 a couple times
    if (this.primeRendersRemaining > 0) {
      this.primeRendersRemaining -= 1;

      const savedStrength = this.bloomPass.strength;

      // Clear explicitly (helps avoid stale RT garbage showing as a flash)
      this.renderer.clear(true, true, true);

      this.bloomPass.strength = 0;
      this.composer.render();
      this.bloomPass.strength = savedStrength;

      // One more clear before the real render (reduces “double image” artifacts)
      this.renderer.clear(true, true, true);
    }

    this.composer.render();
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const pr = Math.max(1, pixelRatio);

    const ignore = Math.max(0, this.settings.stability.resizeIgnorePxJitter);

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

    // Keep bloom RT sizes matched
    this.bloomPass.setSize(this.width, this.height);

    // Critical hardening after resize
    this.framesToStabilize = Math.max(0, this.settings.stability.stabilizationFrames);
    this.primeRendersRemaining = Math.max(0, this.settings.stability.primeFrames);
  }

  public dispose(): void {
    const anyComposer = this.composer as unknown as { dispose?: () => void };
    if (typeof anyComposer.dispose === "function") anyComposer.dispose();
  }

  // ------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------

  private syncBloomStaticParams(): void {
    this.bloomPass.radius = clamp01(this.settings.bloom.radius);
    this.bloomPass.threshold = clamp01(this.settings.bloom.threshold);
  }

  private captureBaselineRendererState(): RendererBaseline {
    const c = new THREE.Color();
    this.renderer.getClearColor(c);
    const a = this.renderer.getClearAlpha();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rAny = this.renderer as any;

    return {
      // When using EffectComposer, autoClear should be false and composer manages clears.
      // But we will enforce it in applyBaselineRendererState().
      autoClear: false,
      clearColor: c.clone(),
      clearAlpha: a,
      toneMapping: this.renderer.toneMapping,
      toneMappingExposure: this.renderer.toneMappingExposure,
      outputColorSpace: rAny.outputColorSpace,
    };
  }

  private applyBaselineRendererState(): void {
    if (!this.baseline) return;

    // Enforce the safest composer-friendly state.
    // If any other system changes these after a resize, this prevents “flash loops.”
    this.renderer.autoClear = this.baseline.autoClear;
    this.renderer.setClearColor(this.baseline.clearColor, this.baseline.clearAlpha);
    this.renderer.toneMapping = this.baseline.toneMapping;
    this.renderer.toneMappingExposure = this.baseline.toneMappingExposure;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rAny = this.renderer as any;
    if (typeof rAny.outputColorSpace !== "undefined" && typeof this.baseline.outputColorSpace !== "undefined") {
      rAny.outputColorSpace = this.baseline.outputColorSpace;
    }
  }
}
