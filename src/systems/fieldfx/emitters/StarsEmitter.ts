// src/systems/fieldfx/emitters/StarsEmitter.ts
// ============================================================
// THE STILL — StarsEmitter
// ------------------------------------------------------------
// Purpose:
//  - Gives BAND stars the same emitter-style architecture as other FieldFX modes
//  - Owns stars-mode material defaults / reset behavior / simulation hook
//  - Does NOT create BAND geometry. StarSystem remains responsible for that.
//
// Notes:
//  - This emitter is intentionally conservative on first pass.
//  - Preserve current visual behavior as much as possible.
//  - Any stars-specific material tuning that currently lives in FieldFXSystem
//    should migrate into this emitter step by step.
// ============================================================

import * as THREE from "three";

export type StarsEmitterMaterialContext = {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  dt: number;
  energy: number;
  intensity: number;
  visibility: number;
  sizeMul: number;
};

export type StarsEmitterResetContext = {
  points: THREE.Points;
  material: THREE.PointsMaterial;
};

export type StarsEmitterSimulateContext = {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  dt: number;
  time: number;
  energy: number;
  intensity: number;
};

export type StarsEmitterOptions = {
  baseOpacity?: number;
  baseIntensity?: number;
  baseSizeMul?: number;
  blending?: THREE.Blending;
  transparent?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  vertexColors?: boolean;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class StarsEmitter {
  public readonly mode = "stars";

  private readonly options: Required<StarsEmitterOptions>;

  constructor(options: StarsEmitterOptions = {}) {
    this.options = {
      baseOpacity: options.baseOpacity ?? 1.0,
      baseIntensity: options.baseIntensity ?? 1.0,
      baseSizeMul: options.baseSizeMul ?? 1.0,
      blending: options.blending ?? THREE.AdditiveBlending,
      transparent: options.transparent ?? true,
      depthWrite: options.depthWrite ?? false,
      depthTest: options.depthTest ?? true,
      vertexColors: options.vertexColors ?? true,
    };
  }

  /**
   * Apply stars-mode material behavior.
   * This should become the single home for star-specific material defaults.
   */
  sampleMaterial(ctx: StarsEmitterMaterialContext): void {
    const {
      material,
      intensity,
      visibility,
      sizeMul,
    } = ctx;

    const finalOpacity =
      this.options.baseOpacity * clamp01(visibility);

    const finalSize =
      this.options.baseSizeMul * Math.max(0, sizeMul);

    material.transparent = this.options.transparent;
    material.blending = this.options.blending;
    material.depthWrite = this.options.depthWrite;
    material.depthTest = this.options.depthTest;
    material.vertexColors = this.options.vertexColors;

    material.opacity = finalOpacity;

    // PointsMaterial.size is still meaningful for the BAND substrate.
    // We keep this conservative to preserve current tuning behavior.
    material.size = finalSize;

    // If your current pipeline uses material.color/intensity coupling elsewhere,
    // keep that there for now. This emitter should become the eventual owner,
    // but not force a behavioral change on pass one.
    const scalar = this.options.baseIntensity * Math.max(0, intensity);
    material.color.setScalar(Math.max(0.0001, scalar));
  }

  /**
   * Restore baseline stars material defaults.
   */
  reset(ctx: StarsEmitterResetContext): void {
    const { material } = ctx;

    material.transparent = this.options.transparent;
    material.blending = this.options.blending;
    material.depthWrite = this.options.depthWrite;
    material.depthTest = this.options.depthTest;
    material.vertexColors = this.options.vertexColors;
    material.opacity = this.options.baseOpacity;
    material.size = this.options.baseSizeMul;
    material.color.setScalar(this.options.baseIntensity);
  }

  /**
   * Stars currently do not need a heavy simulate pass.
   * Keeping the hook here preserves emitter symmetry and gives us a future home
   * for star twinkle / drift / sparkle / pulse rules if desired.
   */
  simulate(_ctx: StarsEmitterSimulateContext): void {
    // Intentionally minimal on first pass.
  }
}