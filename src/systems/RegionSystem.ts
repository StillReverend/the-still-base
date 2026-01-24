// src/systems/RegionSystem.ts
// P05 — Region System (zodiac-lite spatial segmentation)
//
// Goal (P05):
//  - Define 12 stable volumetric "wedge" regions around the Core.
//  - Provide deterministic, read-only spatial queries:
//      * Which region does a world position belong to?
//      * With what strength (soft blending near boundaries)?
//
// NOT YET (explicitly out of scope for P05):
//  - Fog logic, accretion logic, constellation spawning/ownership
//  - Persistence/saving, UI overlays, audio modulation
//  - Any rendering/debug meshes (keep it data + math only)

import { Object3D, Vector3 } from "three";

export type RegionId =
  | "JAN"
  | "FEB"
  | "MAR"
  | "APR"
  | "MAY"
  | "JUN"
  | "JUL"
  | "AUG"
  | "SEP"
  | "OCT"
  | "NOV"
  | "DEC";

export type RegionKey = {
  index: number; // 0..11
  id: RegionId;
  label: string; // e.g., "January"
};

export type RegionDefinition = RegionKey & {
  // Soft "bias knobs" that other systems may read later.
  // (No downstream behavior is implemented here.)
  colorBias: {
    hue: number; // 0..360
    sat: number; // 0..1
    lum: number; // 0..1
  };
};

export type RegionQueryResult = {
  region: RegionDefinition;
  weight: number; // 0..1
  angleRad: number; // [0..2pi)
  distanceToCore: number; // radial distance in the clock plane
};

export type RegionWeights = Array<{
  region: RegionDefinition;
  weight: number; // normalized so sum = 1
}>;

export type RadialFalloffConfig = {
  enabled: boolean;
  start: number; // start radius where falloff begins
  end: number; // end radius where falloff reaches max
  strength: number; // 0..1
};

export type RegionSystemConfig = {
  /**
   * Hard-locked at 12. Kept as config for readability but not user-settable.
   */
  regionCount?: 12;

  /**
   * Rotation offset applied to the computed angle before wedge selection.
   *
   * IMPORTANT:
   * - Our clock face lives in XZ (Y-up).
   * - atan2(z, x) => angle where 0 is +X (3 o'clock), pi/2 is +Z (12 o'clock).
   *
   * To map months so that:
   *  - JAN = 1 o'clock
   *  - FEB = 2 o'clock
   *  - ...
   *  - DEC = 12 o'clock
   *
   * We want Region 0 center at 1 o'clock (60 degrees from +X).
   * With wedge centers at (index*wedge + wedge/2) in "angle space",
   * and since we ADD baseRotation to the measured angle, the region centers
   * in world land at (centerAngle - baseRotation).
   *
   * This yields baseRotation = -45° = -PI/4.
   */
  baseRotationRad?: number;

  /**
   * Boundary softness (0..1): defines blend zone size near each wedge edge.
   * 0 = hard wedges; 1 = very soft/overlapping boundaries.
   */
  boundaryBlend?: number;

  /**
   * Optional radial falloff of region weights based on distance from core.
   * (Currently only modulates weights; caller decides what to do.)
   */
  radialFalloff?: Partial<RadialFalloffConfig>;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const normalizeAngleRad = (a: number): number => {
  const tau = Math.PI * 2;
  const n = a % tau;
  return n < 0 ? n + tau : n;
};

const signedAngleDelta = (a: number, b: number): number => {
  // Smallest signed difference a-b in [-pi, pi]
  const tau = Math.PI * 2;
  let d = (a - b) % tau;
  if (d > Math.PI) d -= tau;
  if (d < -Math.PI) d += tau;
  return d;
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const createDefaultRegions = (): RegionDefinition[] => {
  const ids: RegionId[] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const labels = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // Simple hue ramp (stable ordering). You can refine later.
  const hues = [200, 220, 245, 275, 305, 335, 10, 40, 70, 110, 150, 180];

  return ids.map((id, i) => ({
    index: i,
    id,
    label: labels[i],
    colorBias: {
      hue: hues[i % hues.length],
      sat: 0.35,
      lum: 0.55,
    },
  }));
};

export class RegionSystem {
  private readonly config: Required<RegionSystemConfig>;
  private readonly regions: RegionDefinition[];

  // Optional canonical orientation anchor.
  // If set, we evaluate all region math in ClockFace-local space.
  private clockFace: Object3D | null = null;

  // Scratch vectors to avoid allocations each query.
  private readonly _tmpLocal = new Vector3();
  private readonly _tmpWorld = new Vector3();

  // Precomputed wedge size
  private readonly wedgeSizeRad: number;
  private readonly halfWedgeRad: number;
  private readonly blendZoneRad: number;

  constructor(config?: RegionSystemConfig) {
    // Hard-lock regionCount to 12 for stability.
    const regionCount: 12 = 12;

    // Default baseRotationRad maps:
    //  Region 0 (JAN) -> 1 o'clock
    //  Region 1 (FEB) -> 2 o'clock
    //  ...
    //  Region 11 (DEC) -> 12 o'clock
    const defaultBaseRotation = -Math.PI / 4;

    this.config = {
      regionCount,
      baseRotationRad: config?.baseRotationRad ?? defaultBaseRotation,
      boundaryBlend: clamp01(config?.boundaryBlend ?? 0.25),
      radialFalloff: {
        enabled: config?.radialFalloff?.enabled ?? false,
        start: config?.radialFalloff?.start ?? 10,
        end: config?.radialFalloff?.end ?? 80,
        strength: clamp01(config?.radialFalloff?.strength ?? 0.35),
      },
    };

    this.regions = createDefaultRegions();

    this.wedgeSizeRad = (Math.PI * 2) / this.config.regionCount;
    this.halfWedgeRad = this.wedgeSizeRad * 0.5;
    this.blendZoneRad = this.halfWedgeRad * this.config.boundaryBlend;
  }

  /**
   * Optional: provide the canonical ClockFace anchor (Object3D).
   * If set, region math will use ClockFace-local XZ coordinates.
   */
  setClockFace(clockFace: Object3D | null): void {
    this.clockFace = clockFace;
  }

  /**
   * Expose resolved config for other systems (e.g., debug overlay alignment).
   */
  getConfig(): Readonly<Required<RegionSystemConfig>> {
    return this.config;
  }

  /**
   * Read-only list of region definitions (stable ordering).
   */
  getRegions(): readonly RegionDefinition[] {
    return this.regions;
  }

  /**
   * Primary query: returns the strongest region + its weight for a given world position.
   */
  getRegionAtPosition(pos: Vector3): RegionQueryResult {
    const angle = this.getAngleForPosition(pos);
    const distanceToCore = this.getRadialDistance(pos);

    // Find nearest wedge center
    const regionIndex = this.getNearestRegionIndex(angle);
    const region = this.regions[regionIndex];

    const weight = this.computeRegionWeight(regionIndex, angle, distanceToCore);

    return {
      region,
      weight,
      angleRad: angle,
      distanceToCore,
    };
  }

  /**
   * Full distribution query: returns normalized weights for all 12 regions.
   * Useful for smooth blending (fog/audio/visual biases later).
   */
  getRegionWeightsAtPosition(pos: Vector3): RegionWeights {
    const angle = this.getAngleForPosition(pos);
    const distanceToCore = this.getRadialDistance(pos);

    const raw: Array<{ region: RegionDefinition; weight: number }> = this.regions.map((region) => ({
      region,
      weight: this.computeRegionWeight(region.index, angle, distanceToCore),
    }));

    // Normalize so weights sum to 1 (unless all are 0, which shouldn't happen)
    const sum = raw.reduce((acc, r) => acc + r.weight, 0);
    if (sum <= 1e-8) {
      // Degenerate fallback: assign all weight to nearest region
      const idx = this.getNearestRegionIndex(angle);
      return this.regions.map((r, i) => ({
        region: r,
        weight: i === idx ? 1 : 0,
      }));
    }

    return raw.map((r) => ({
      region: r.region,
      weight: r.weight / sum,
    }));
  }

  /**
   * Utility: Get region index from a RegionId.
   */
  getRegionIndexById(id: RegionId): number {
    const idx = this.regions.findIndex((r) => r.id === id);
    return idx >= 0 ? idx : 0;
  }

  /**
   * Utility: Get region definition by index (0..11).
   */
  getRegionByIndex(index: number): RegionDefinition {
    const i = ((index % 12) + 12) % 12;
    return this.regions[i];
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private getLocalClockPos(worldPos: Vector3): Vector3 {
    // If no ClockFace is provided, treat world space as clock space.
    if (!this.clockFace) return worldPos;

    // NOTE:
    // This relies on the ClockFace having an up-to-date matrixWorld.
    // (Which Three.js ensures when rendering, but callers should avoid querying
    // before the scene graph has been updated at least once.)
    this._tmpWorld.copy(worldPos);

    // Ensure matrixWorld is current (prevents first-frame / pre-render mismatches)
    this.clockFace.updateWorldMatrix(true, false);

    return this.clockFace.worldToLocal(this._tmpLocal.copy(this._tmpWorld));
  }

  private getAngleForPosition(pos: Vector3): number {
    // Angle around Y axis using XZ plane in CLOCK SPACE.
    // atan2(z, x) returns [-pi, pi]; normalize to [0, 2pi)
    const p = this.getLocalClockPos(pos);

    const a = Math.atan2(p.z, p.x);
    const rotated = a + this.config.baseRotationRad;
    return normalizeAngleRad(rotated);
  }

  private getRadialDistance(pos: Vector3): number {
    // Radial distance in XZ plane (ignoring Y) in CLOCK SPACE.
    const p = this.getLocalClockPos(pos);
    return Math.sqrt(p.x * p.x + p.z * p.z);
  }

  private getRegionCenterAngle(index: number): number {
    // Center of wedge i (in "angle space", BEFORE baseRotation is applied)
    return normalizeAngleRad(index * this.wedgeSizeRad + this.halfWedgeRad);
  }

  private getNearestRegionIndex(angleRad: number): number {
    // Convert angle to wedge index directly.
    // Example: angle 0..wedgeSize => index 0, etc.
    const idx = Math.floor(angleRad / this.wedgeSizeRad);
    return ((idx % 12) + 12) % 12;
  }

  private computeRegionWeight(regionIndex: number, angleRad: number, distanceToCore: number): number {
    // Angular membership:
    // - Full weight near the wedge center
    // - Smoothly falls to 0 as we approach the wedge edge (with blend zone)
    //
    // Let d = absolute angular distance to region center
    // - If d <= (halfWedge - blendZone): weight=1
    // - If d >= halfWedge: weight=0
    // - Else: smoothstep down across blend zone
    const center = this.getRegionCenterAngle(regionIndex);
    const d = Math.abs(signedAngleDelta(angleRad, center));

    const innerFull = Math.max(0, this.halfWedgeRad - this.blendZoneRad);
    let wAngular: number;

    if (d <= innerFull) {
      wAngular = 1;
    } else if (d >= this.halfWedgeRad) {
      wAngular = 0;
    } else {
      // Map d from [innerFull .. halfWedge] to [1 .. 0]
      const t = smoothstep(innerFull, this.halfWedgeRad, d);
      wAngular = 1 - t;
    }

    // Optional radial falloff (attenuate weights by distance)
    if (!this.config.radialFalloff.enabled) return wAngular;

    const { start, end, strength } = this.config.radialFalloff;

    if (end <= start) return wAngular;

    const t = clamp01((distanceToCore - start) / (end - start));
    // 0 => no attenuation, 1 => max attenuation
    const attenuation = 1 - t * strength;

    return wAngular * attenuation;
  }
}
