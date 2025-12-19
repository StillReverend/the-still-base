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

import { Vector3 } from "three";

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
    hue: number; // 0..360 (semantic, not literal rendering)
    sat: number; // 0..1
    lum: number; // 0..1
  };
  vibeBias: {
    warmth: number; // -1..1
    calm: number; // -1..1
    intensity: number; // 0..1
  };
};

export type RegionQueryResult = {
  region: RegionDefinition;
  weight: number; // 0..1 (how strongly the position belongs to that region)
  angleRad: number; // world angle used for evaluation
  distanceToCore: number; // radial distance in XZ plane
};

export type RegionWeights = Array<{
  region: RegionDefinition;
  weight: number; // 0..1 (normalized across all 12)
}>;

export type RegionSystemConfig = {
  regionCount?: 12; // fixed for now (zodiac-lite). Keep as a literal for stability.
  // Axis convention:
  //  - We treat the Core as origin (0,0,0)
  //  - Regions are wedges around the Y axis.
  //  - Angle is computed from XZ plane:
  //      angle = atan2(z, x)
  // If your world is oriented differently, adjust angle mapping here.
  baseRotationRad?: number; // rotates the entire region wheel
  // Soft blending:
  //  - boundaryBlend: fraction of wedge half-width used as blend zone (0..1)
  //    e.g. 0.25 means the outer 25% near edges blends to neighbors.
  boundaryBlend?: number;
  // Radial weighting:
  //  - Region membership can optionally bias inward vs outward.
  //  - Keeping this mild prevents "rings" feeling like hard shells.
  radialFalloff?: {
    enabled: boolean;
    // Start applying radial weighting after this distance (in world units)
    start: number;
    // Full effect by this distance (in world units)
    end: number;
    // Strength 0..1 (0 disables even if enabled = true)
    strength: number;
  };
};

const REGION_ORDER: Array<{ id: RegionId; label: string }> = [
  { id: "JAN", label: "January" },
  { id: "FEB", label: "February" },
  { id: "MAR", label: "March" },
  { id: "APR", label: "April" },
  { id: "MAY", label: "May" },
  { id: "JUN", label: "June" },
  { id: "JUL", label: "July" },
  { id: "AUG", label: "August" },
  { id: "SEP", label: "September" },
  { id: "OCT", label: "October" },
  { id: "NOV", label: "November" },
  { id: "DEC", label: "December" },
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Smallest signed angular distance from a to b in radians, in [-pi, pi].
 */
function signedAngleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Maps any angle to [0, 2pi).
 */
function normalizeAngleRad(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a;
}

/**
 * Default region definitions.
 * NOTE: These biases are *semantic placeholders* for later systems.
 * Keep stable IDs + indices. Feel free to tune bias values later without breaking IDs.
 */
function createDefaultRegions(): RegionDefinition[] {
  // A gentle wheel of hues (not literal). Even spacing:
  // 0..330 stepping 30 degrees.
  // Sat/lum modest to avoid "neon rainbow mandate" in data.
  return REGION_ORDER.map((r, i) => {
    const hue = i * 30; // 0..330
    return {
      index: i,
      id: r.id,
      label: r.label,
      colorBias: {
        hue,
        sat: 0.35,
        lum: 0.55,
      },
      vibeBias: {
        // Lightly cyclical placeholders
        warmth: Math.sin((i / 12) * Math.PI * 2) * 0.4,
        calm: Math.cos((i / 12) * Math.PI * 2) * 0.4,
        intensity: 0.35,
      },
    };
  });
}

export class RegionSystem {
  private readonly config: Required<RegionSystemConfig>;
  private readonly regions: RegionDefinition[];

  // Precomputed wedge size
  private readonly wedgeSizeRad: number;
  private readonly halfWedgeRad: number;
  private readonly blendZoneRad: number;

  constructor(config?: RegionSystemConfig) {
    // Hard-lock regionCount to 12 for stability.
    const regionCount: 12 = 12;

    this.config = {
      regionCount,
      baseRotationRad: config?.baseRotationRad ?? 0,
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

    const raw: Array<{ region: RegionDefinition; weight: number }> = this.regions.map(
      (region) => ({
        region,
        weight: this.computeRegionWeight(region.index, angle, distanceToCore),
      })
    );

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
    const i = ((Math.floor(index) % 12) + 12) % 12;
    return this.regions[i];
  }

  // -----------------------------
  // Internal math
  // -----------------------------

  private getAngleForPosition(pos: Vector3): number {
    // Angle around Y axis using XZ plane
    // atan2(z, x) returns [-pi, pi]; normalize to [0, 2pi)
    const a = Math.atan2(pos.z, pos.x);
    const rotated = a + this.config.baseRotationRad;
    return normalizeAngleRad(rotated);
  }

  private getRadialDistance(pos: Vector3): number {
    // Radial distance in XZ plane (ignoring Y)
    return Math.sqrt(pos.x * pos.x + pos.z * pos.z);
  }

  private getRegionCenterAngle(index: number): number {
    // Center of wedge i
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

    // Optional radial falloff:
    // This is intentionally mild. It should feel like bias, not a shell.
    let wRadial = 1;
    const rf = this.config.radialFalloff;
    if (rf.enabled && rf.strength > 0) {
      const t = smoothstep(rf.start, rf.end, distanceToCore); // 0..1 as we go outward
      // Apply a gentle attenuation with distance (or invert later if desired).
      // Current behavior:
      //  - Near core: multiplier ~1
      //  - Far out: multiplier ~ (1 - strength)
      wRadial = lerp(1, 1 - rf.strength, t);
    }

    return clamp01(wAngular * wRadial);
  }
}
