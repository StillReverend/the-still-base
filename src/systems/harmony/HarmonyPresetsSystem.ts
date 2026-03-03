// src/systems/harmony/HarmonyPresetsSystem.ts
// ============================================================
// THE STILL — HarmonyPresetsSystem (Phase 1)
//  - Owns a tiny Presets catalog (MVP)
//  - Applies presets by emitting a full environment snapshot
//  - Does NOT import PostFX / Howler / Stars / etc.
//  - Presets use OVERWRITE semantics (A)
// ============================================================

import type { EventBus } from "../../core/EventBus";

type AnyFn = (...args: any[]) => void;

export type HarmonyEnvironmentSnapshot = {
  colorId: string;
  filterId: string;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
};

export type HarmonyPreset = {
  id: string;
  label: string;
  environment: HarmonyEnvironmentSnapshot;
};

const PRESETS: HarmonyPreset[] = [
  {
    id: "dusk",
    label: "Dusk",
    environment: {
      colorId: "c1",
      filterId: "f3",
      particles: {
        dust: true,
      },
      ambients: {
        crickets: true,
      },
    },
  },
  {
    id: "void",
    label: "Void",
    environment: {
      colorId: "c1",
      filterId: "f2",
      particles: {},
      ambients: {
        wind: true,
      },
    },
  },
  {
    id: "clear",
    label: "Clear",
    environment: {
      colorId: "c1",
      filterId: "f1",
      particles: {},
      ambients: {},
    },
  },

  // ✅ New preset: Lumen
  // - Uses new filter id "lumen" (added in HarmonyUI)
  // - A little “alive” and bright: stars on + gentle chimes
  {
    id: "lumen",
    label: "Lumen",
    environment: {
      colorId: "c1",
      filterId: "lumen",
      particles: {
        stars: true,
      },
      ambients: {
        chimes: true,
      },
    },
  },
];

export class HarmonyPresetsSystem {
  private readonly bus: EventBus;
  private disposers: Array<() => void> = [];
  private initialized = false;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // ------------------------------------------------------------
    // Apply Preset (OVERWRITE semantics)
    // ------------------------------------------------------------
    this.on("harmony:preset:apply", (p: { presetId: string }) => {
      const id = String(p?.presetId ?? "")
        .trim()
        .toLowerCase();

      if (!id) return;

      const preset = PRESETS.find((x) => x.id === id);
      if (!preset) return;

      // Emit full environment snapshot.
      // HarmonyEnvironmentSystem will overwrite canonical state.
      this.bus.emit("harmony:environment:apply", {
        environment: preset.environment,
        source: "preset",
      });
    });

    // ------------------------------------------------------------
    // Catalog request (UI helper)
    // ------------------------------------------------------------
    this.on("harmony:presets:requestCatalog", () => {
      this.bus.emit("harmony:presets:catalog", {
        presets: PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
        })),
      });
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.initialized = false;
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);
    this.disposers.push(() => this.bus.off(event, handler));
  }
}