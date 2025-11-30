// src/core/Config.ts

export type DistanceMode = "near" | "mid" | "far";

export interface Config {
  pixelRatio: number;
  maxDeltaTime: number;
  distanceMode: DistanceMode;

  // Phase P01: keep it minimal; we’ll extend in later phases
}

export const createDefaultConfig = (): Config => {
  const devicePR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  return {
    pixelRatio: Math.min(devicePR, 2),
    maxDeltaTime: 1 / 15, // clamp dt to avoid giant jumps
    distanceMode: "mid",
  };
};
