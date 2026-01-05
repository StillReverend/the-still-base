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

export type BloomSettings = {
  enabled: boolean;
  strength: number;  // typical: 0.4 - 1.8
  radius: number;    // typical: 0.0 - 1.0
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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

  merged.bloom.strength = Math.max(0, merged.bloom.strength);
  merged.bloom.radius = Math.max(0, merged.bloom.radius);
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

    // Bloom
    const res = new THREE.Vector2(this.width, this.height);
    this.bloomPass = new UnrealBloomPass(
      res,
      this.settings.bloom.strength,
      this.settings.bloom.radius,
      this.settings.bloom.threshold,
    );
    this.bloomPass.enabled = this.settings.bloom.enabled;
    this.composer.addPass(this.bloomPass);
  }

  /** Swap scene/camera without rebuilding the whole pipeline. */
  public setTargets(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;

    // RenderPass expects these to be mutable.
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
  }

  public setBloom(params: Partial<Omit<BloomSettings, "enabled">>): void {
    if (typeof params.strength === "number") {
      this.settings.bloom.strength = Math.max(0, params.strength);
      this.bloomPass.strength = this.settings.bloom.strength;
    }
    if (typeof params.radius === "number") {
      this.settings.bloom.radius = Math.max(0, params.radius);
      this.bloomPass.radius = this.settings.bloom.radius;
    }
    if (typeof params.threshold === "number") {
      this.settings.bloom.threshold = clamp01(params.threshold);
      this.bloomPass.threshold = this.settings.bloom.threshold;
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

    // UnrealBloomPass stores its own resolution vector.
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

  /** If you want to add additional passes later. */
  public getComposer(): EffectComposer {
    return this.composer;
  }

  public dispose(): void {
    // Pass cleanup
    this.composer.removePass(this.renderPass);
    this.composer.removePass(this.bloomPass);

    this.bloomPass.dispose();

    // Composer render targets (defensive, varies by three version)
    // @ts-expect-error - internal fields exist in three
    this.composer.renderTarget1?.dispose?.();
    // @ts-expect-error - internal fields exist in three
    this.composer.renderTarget2?.dispose?.();

    // @ts-expect-error - composer may have dispose in newer three
    this.composer.dispose?.();

    // Break refs
    // @ts-expect-error: explicit nulling for GC friendliness
    this.composer = null;
    // @ts-expect-error
    this.renderPass = null;
    // @ts-expect-error
    this.bloomPass = null;
  }
}
