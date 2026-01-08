// ============================================================
// THE STILL — P03.x
// PostFXSystem.ts
// ------------------------------------------------------------
// Purpose:
//  - Own a single EffectComposer pipeline (RenderPass + optional Bloom)
//  - Be safe to add now without forcing integration everywhere yet
//
// Key idea:
//  - If PostFX is disabled, it simply falls back to renderer.render(scene, camera)
//  - When you’re ready, Engine can call postFX.render() instead of renderer.render()
//
// Notes:
//  - This is intentionally minimal and future-safe.
//  - We can add more passes later (film grain, vignette, chromatic aberration, LUT, etc.).
// ============================================================

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export type PostFXProfileName = "solar" | "luna" | "blackHole";

type BloomProfile = {
  /** UnrealBloomPass threshold */
  threshold: number;
  /** UnrealBloomPass strength */
  strength: number;
  /** UnrealBloomPass radius */
  radius: number;
};

/**
 * Baseline bloom looks:
 * - solar: hot neon lens bleed
 * - luna: quieter photographic glow
 * - blackHole: restrained, sharp highlights only
 *
 * IMPORTANT:
 * If blackHole threshold is too low, any single-frame artifact can “flash”.
 */
const BLOOM_PROFILES: Record<PostFXProfileName, BloomProfile> = {
  solar:     { threshold: 0.30, strength: 1.45, radius: 0.50 },
  luna:      { threshold: 0.20, strength: 1.35, radius: 0.40 },
  blackHole: { threshold: 0.10, strength: 1.25, radius: 0.30 },
};

export type BloomSettings = {
  enabled: boolean;
  strength: number; // typical: 0.4 - 1.8
  radius: number; // typical: 0.0 - 1.0
  threshold: number; // typical: 0.0 - 1.0
};

export type PostFXSettings = {
  enabled: boolean;
  bloom: BloomSettings;
};

export type PostFXDeps = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;

  width: number;
  height: number;

  /** Optional override. If omitted, we use renderer.getPixelRatio(). */
  pixelRatio?: number;

  /** Optional initial settings overrides. */
  settings?: Partial<PostFXSettings>;
};

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
};

const defaultSettings: PostFXSettings = {
  enabled: true,
  bloom: {
    enabled: true,
    strength: 1.05,
    radius: 0.55,
    threshold: 0.12,
  },
};

function mergeSettings(override?: Partial<PostFXSettings>): PostFXSettings {
  if (!override) return structuredClone(defaultSettings);

  const merged: PostFXSettings = {
    enabled: override.enabled ?? defaultSettings.enabled,
    bloom: {
      enabled: override.bloom?.enabled ?? defaultSettings.bloom.enabled,
      strength: override.bloom?.strength ?? defaultSettings.bloom.strength,
      radius: override.bloom?.radius ?? defaultSettings.bloom.radius,
      threshold: override.bloom?.threshold ?? defaultSettings.bloom.threshold,
    },
  };

  merged.bloom.strength = Number.isFinite(merged.bloom.strength) ? Math.max(0, merged.bloom.strength) : 0;
  merged.bloom.radius = Number.isFinite(merged.bloom.radius) ? Math.max(0, merged.bloom.radius) : 0;
  merged.bloom.threshold = clamp01(merged.bloom.threshold);

  return merged;
}

export class PostFXSystem {
  private readonly renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;

  private width: number;
  private height: number;
  private pixelRatio: number;

  private settings: PostFXSettings;

  // ----------------------------------------------------------
  // Profiles + modulation
  // ----------------------------------------------------------
  private profile: PostFXProfileName = "blackHole";
  private bloomBase: BloomProfile = { ...BLOOM_PROFILES.blackHole };

  // 0..1 from audio (or other continuous driver)
  private bloomAudio = 0;

  // cinematic multiplier (1 = normal)
  private bloomCinematic = 1.0;

  // Cache so we don’t thrash bloomPass every frame
  private lastAppliedStrength = -1;

  constructor(deps: PostFXDeps) {
    this.renderer = deps.renderer;
    this.scene = deps.scene;
    this.camera = deps.camera;

    this.width = deps.width;
    this.height = deps.height;
    this.pixelRatio = deps.pixelRatio ?? this.renderer.getPixelRatio();

    this.settings = mergeSettings(deps.settings);

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    const res = new THREE.Vector2(this.width, this.height);
    this.bloomPass = new UnrealBloomPass(
      res,
      this.settings.bloom.strength,
      this.settings.bloom.radius,
      this.settings.bloom.threshold,
    );
    this.bloomPass.enabled = this.settings.bloom.enabled;
    this.composer.addPass(this.bloomPass);

    // Initialize base from settings so we don’t “jump”
    this.bloomBase = {
      threshold: this.settings.bloom.threshold,
      strength: this.settings.bloom.strength,
      radius: this.settings.bloom.radius,
    };

    // Ensure strength cache starts correct
    this.lastAppliedStrength = -1;
    this.applyBloomStrength();
  }

  /** Swap scene/camera without rebuilding the whole pipeline. */
  public setTargets(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;

    this.renderPass.scene = scene;
    // @ts-expect-error: RenderPass camera is mutable in practice
    this.renderPass.camera = camera;
  }

  public getSettings(): PostFXSettings {
    return structuredClone(this.settings);
  }

  public setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled;
  }

  public setBloomEnabled(enabled: boolean): void {
    this.settings.bloom.enabled = enabled;
    this.bloomPass.enabled = enabled;

    // When re-enabling, force a fresh apply so we don’t “wake up” with stale strength
    this.lastAppliedStrength = -1;
    if (enabled) this.applyBloomStrength();
  }

  /**
   * Manual bloom override (editor knobs).
   * This also updates the active base profile values so audio/cinematic modulation
   * continues to behave predictably.
   */
  public setBloom(params: Partial<Omit<BloomSettings, "enabled">>): void {
    if (typeof params.threshold === "number") {
      const v = clamp01(params.threshold);
      this.settings.bloom.threshold = v;
      this.bloomBase.threshold = v;
      this.bloomPass.threshold = v;
    }

    if (typeof params.radius === "number") {
      const v = Number.isFinite(params.radius) ? Math.max(0, params.radius) : 0;
      this.settings.bloom.radius = v;
      this.bloomBase.radius = v;
      this.bloomPass.radius = v;
    }

    if (typeof params.strength === "number") {
      const v = Number.isFinite(params.strength) ? Math.max(0, params.strength) : 0;
      this.settings.bloom.strength = v;
      this.bloomBase.strength = v;
      this.applyBloomStrength();
    }
  }

  // ----------------------------------------------------------
  // Profiles
  // ----------------------------------------------------------

  public getProfile(): PostFXProfileName {
    return this.profile;
  }

  public setProfile(name: PostFXProfileName): void {
    this.profile = name;
    this.bloomBase = { ...BLOOM_PROFILES[name] };

    // Keep settings in sync
    this.settings.bloom.threshold = this.bloomBase.threshold;
    this.settings.bloom.radius = this.bloomBase.radius;
    this.settings.bloom.strength = this.bloomBase.strength;

    this.bloomPass.threshold = this.bloomBase.threshold;
    this.bloomPass.radius = this.bloomBase.radius;

    // Force re-apply even if cache was close
    this.lastAppliedStrength = -1;
    this.applyBloomStrength();
  }

  /** 0..1 energy driver (audio RMS, etc.). */
  public setBloomAudio(value01: number): void {
    this.bloomAudio = clamp01(value01);
    this.applyBloomStrength();
  }

  /** Cinematic multiplier (1 = normal). */
  public setBloomCinematic(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return;
    this.bloomCinematic = Math.max(0, multiplier);
    this.applyBloomStrength();
  }

  private applyBloomStrength(): void {
    if (!this.settings.bloom.enabled) return;

    const a = this.bloomAudio;
    const audioBoost = 1.0 + (a * a) * 0.65;

    const rawStrength = this.bloomBase.strength * audioBoost * this.bloomCinematic;
    if (!Number.isFinite(rawStrength)) return;

    const safeStrength = Math.max(0, rawStrength);

    // Only apply if it actually changed meaningfully
    if (Math.abs(safeStrength - this.lastAppliedStrength) > 0.001) {
      this.bloomPass.strength = safeStrength;
      this.lastAppliedStrength = safeStrength;
    }
  }

  /** Call from your resize handler. */
  public resize(width: number, height: number, pixelRatio?: number): void {
    this.width = width;
    this.height = height;

    if (typeof pixelRatio === "number") {
      this.pixelRatio = pixelRatio;
      this.composer.setPixelRatio(this.pixelRatio);
    }

    this.composer.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width, this.height);
  }

  /**
   * Render one frame.
   * - If PostFX is disabled, we render normally.
   * - If enabled, composer.render() handles the full chain.
   */
  public render(): void {
    if (!this.settings.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.composer.render();
  }

  public getComposer(): EffectComposer {
    return this.composer;
  }

  public dispose(): void {
    this.composer.removePass(this.renderPass);
    this.composer.removePass(this.bloomPass);

    this.bloomPass.dispose();

    // @ts-expect-error - internal fields exist in three
    this.composer.renderTarget1?.dispose?.();
    // @ts-expect-error - internal fields exist in three
    this.composer.renderTarget2?.dispose?.();

    // @ts-expect-error - composer may have dispose in newer three
    this.composer.dispose?.();

    // @ts-expect-error: explicit nulling for GC friendliness
    this.composer = null;
    // @ts-expect-error
    this.renderPass = null;
    // @ts-expect-error
    this.bloomPass = null;
  }
}
