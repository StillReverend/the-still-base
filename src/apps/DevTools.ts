// src/apps/DevTools.ts

// ============================================================
// THE STILL — P03
// DevTools.ts
// ------------------------------------------------------------
// Responsibilities:
//  - Centralize ALL developer hotkeys and quick-toggles.
//  - Keep input capture (keydown/keyup) out of Systems.
//  - Own Engine-level toggles directly (PostFX, Bloom, DebugOverlay).
//  - Emit EventBus events for scene-owned toggles (Core, Regions, etc.).
//
// Design:
//  - DevTools listens to window keyboard events.
//  - Uses e.key (lowercased) for consistency with Engine.ts.
//  - Emits events via EventBus.emit().
//
// Notes:
//  - Instantiate only in DEV.
// ============================================================

import type { EventBus } from "../core/EventBus";
import type { PostFXSystem } from "../systems/PostFXSystem";

export type ToggleableOverlay = {
  isVisible?: () => boolean;
  setVisible?: (visible: boolean) => void;
  toggleVisible?: () => void;
};

export type DevToolBinding = {
  key: string; // match against e.key.toLowerCase()
  label: string;
  when?: (e: KeyboardEvent) => boolean;
  action: (e: KeyboardEvent) => void;
};

export interface DevToolsDeps {
  bus: EventBus;
  postFX: PostFXSystem;
  overlay?: ToggleableOverlay;
  enabled?: boolean;
  verbose?: boolean;
}

export class DevTools {
  private readonly bus: EventBus;
  private readonly postFX: PostFXSystem;
  private readonly overlay: ToggleableOverlay | null;

  private enabled = true;
  private verbose = false;

  private bindings: Map<string, DevToolBinding> = new Map();

  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(deps: DevToolsDeps) {
    this.bus = deps.bus;
    this.postFX = deps.postFX;
    this.overlay = deps.overlay ?? null;

    this.enabled = deps.enabled ?? true;
    this.verbose = deps.verbose ?? false;

    this.registerDefaultBindings();
    this.attach();
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  public getBindings(): ReadonlyArray<DevToolBinding> {
    return Array.from(this.bindings.values());
  }

  public dispose(): void {
    if (this.onKeyDown) {
      window.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }
    this.bindings.clear();
  }

  // ----------------------------------------------------------
  // Internal
  // ----------------------------------------------------------

  private attach(): void {
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      if (this.isTypingTarget(e)) return;
      if (e.repeat) return;

      const key = (e.key || "").toLowerCase();
      if (!key) return;

      const binding = this.bindings.get(key);
      if (!binding) return;

      if (binding.when && !binding.when(e)) return;

      if (this.verbose && import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log(`[DevTools] key="${key}" -> ${binding.label}`);
      }

      binding.action(e);
    };

    window.addEventListener("keydown", this.onKeyDown);
  }

  private isTypingTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;

    const tag = t.tagName?.toLowerCase?.() ?? "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;

    // Any contenteditable region should suppress hotkeys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyT = t as any;
    if (anyT.isContentEditable) return true;

    return false;
  }

  private register(key: string, binding: Omit<DevToolBinding, "key">): void {
    this.bindings.set(key.toLowerCase(), {
      key: key.toLowerCase(),
      ...binding,
    });
  }

  private registerDefaultBindings(): void {
    // --------------------------------------------------------
    // Engine-owned toggles
    // --------------------------------------------------------

    this.register("b", {
      label: "Toggle Bloom",
      action: () => {
        const s = this.postFX.getSettings();
        this.postFX.setBloomEnabled(!s.bloom.enabled);
        // eslint-disable-next-line no-console
        console.log(`[Dev] Bloom ${!s.bloom.enabled ? "ON" : "OFF"}`);
      },
    });

    this.register("p", {
      label: "Toggle PostFX",
      action: () => {
        const s = this.postFX.getSettings();
        this.postFX.setEnabled(!s.enabled);
        // eslint-disable-next-line no-console
        console.log(`[Dev] PostFX ${!s.enabled ? "ON" : "OFF"}`);
      },
    });

    // --------------------------------------------------------
    // PostFX debug helpers
    // --------------------------------------------------------
    // M: Max bloom to detect bright-blob / threshold issues fast
    // Shift+M: Disable max-bloom override
    //
    // T: Telemetry spam (throttled) to understand PostFX timing
    // Shift+T: Disable telemetry
    this.register("m", {
      label: "PostFX Debug — Max Bloom (M on, Shift+M off)",
      action: (e) => {
        const enabled = !e.shiftKey;

        this.bus.emit("postfx:debug-max-bloom", {
          enabled,
          strength: 30,
          radius: 1.0,
          threshold: 0.0,
        });

        // eslint-disable-next-line no-console
        console.log(`[Dev] PostFX debug max-bloom ${enabled ? "ON" : "OFF"}`);
      },
    });

    this.register("t", {
      label: "PostFX Debug — Telemetry (T on, Shift+T off)",
      action: (e) => {
        const enabled = !e.shiftKey;

        this.bus.emit("postfx:debug-telemetry", { enabled, hz: 6 });

        // eslint-disable-next-line no-console
        console.log(`[Dev] PostFX debug telemetry ${enabled ? "ON" : "OFF"}`);
      },
    });

    // Tab toggles overlay visibility. Prevent default Tab focus behavior.
    this.register("tab", {
      label: "Toggle Debug Overlay (Tab)",
      when: () => !!this.overlay,
      action: (e) => {
        e.preventDefault();

        if (!this.overlay) return;

        if (this.overlay.toggleVisible) {
          this.overlay.toggleVisible();
          return;
        }

        const isVis = this.overlay.isVisible?.() ?? true;
        this.overlay.setVisible?.(!isVis);
      },
    });

    // Keep the existing "O" toggle as an alternate.
    this.register("o", {
      label: "Toggle Debug Overlay",
      when: () => !!this.overlay,
      action: () => {
        if (!this.overlay) return;

        if (this.overlay.toggleVisible) {
          this.overlay.toggleVisible();
          return;
        }

        const isVis = this.overlay.isVisible?.() ?? true;
        this.overlay.setVisible?.(!isVis);
      },
    });

    // --------------------------------------------------------
    // Scene-owned controls (emit events; scenes/systems decide)
    // --------------------------------------------------------

    this.register("c", {
      label: "Cycle Core Phase (Solar → Lunar → Black Hole)",
      action: () => {
        this.bus.emit("dev:core:cycle", {});
      },
    });

    this.register("escape", {
      label: "Clear Core Override (return to time-of-day)",
      action: () => {
        this.bus.emit("dev:core:clear", {});
      },
    });

    this.register("r", {
      label: "Toggle Region Overlay",
      action: () => {
        this.bus.emit("dev:regions:toggle", {});
      },
    });

    // --------------------------------------------------------
    // Harmony / Persistence — DEV unlock helpers
    // --------------------------------------------------------
    // H: Force-unlock Harmony UI for testing (persisted)
    // Shift+H: Revert to normal user mode (persisted)
    // L: Toggle owner (Lumen ↔ Director), persisted
    this.register("h", {
      label: "Harmony DEV Unlock (H on, Shift+H off) — persisted",
      action: (e) => {
        const enable = !e.shiftKey;
        const unlockAll = enable
          ? {
              presets: { dusk: true, void: true, clear: true },
              ambients: { crickets: true, waves: true, wind: true, chimes: true },
              particles: { stars: true, fireflies: true, leaves: true, rain: true, snow: true, dust: true, embers: true },
              filters: { f1: true, f2: true, f3: true, f4: true },
              colors: { c1: true, c2: true, c3: true, c4: true },
            }
          : null;

        // 1) Persist intent (sticky across reloads)
        this.bus.emit("dev:persistence:patch", {
          reason: enable ? "dev:harmony:unlock-on" : "dev:harmony:unlock-off",
          commit: true,
          partial: {
            owner: enable ? "director" : "lumen",
            uiMode: "full",
            capabilityOverrides: {
              devUnlockAllHarmony: enable,
            },
            ...(enable ? { unlocks: unlockAll } : {}),
          },
        });

        // 2) Apply LIVE Harmony policy immediately (so UI changes now)
        if (enable) {
          const unlockAll = {
            presets: { dusk: true, void: true, clear: true },
            ambients: { crickets: true, waves: true, wind: true, chimes: true },
            particles: { stars: true, fireflies: true, leaves: true, rain: true, snow: true, dust: true, embers: true },
            filters: { f1: true, f2: true, f3: true, f4: true },
            lumen: { b1: true, b2: true, b3: true, b4: true },
            colors: { c1: true, c2: true, c3: true, c4: true },
          };

          this.bus.emit("harmony:state:patch", {
            owner: "director",
            uiMode: "full",
            capabilities: {
              "playback.basic": true,
              "playback.transport": true,
              "playback.shuffle": true,
              "playback.repeat": true,
              "env.panel": true,
              "env.colors": true,
              "env.filters": true,
              "env.particles": true,
              "env.ambients": true,
              "env.presets": true,
              "mix.lanes": true,
              "ui.hide": true,
            },
            unlocks: unlockAll,
          });

          // eslint-disable-next-line no-console
          console.log("[Dev] Harmony dev unlock ON (persisted + live)");
          return;
        }

        // Shift+H: we cannot "clear" unlock maps due to merge semantics,
        // so we force-lock by disabling env capabilities (authoritative in UI).
        this.bus.emit("harmony:state:patch", {
          owner: "lumen",
          uiMode: "full",
          capabilities: {
            // Keep the panel itself available, but lock its contents:
            "env.panel": true,

            "env.colors": false,
            "env.filters": false,
            "env.particles": false,
            "env.ambients": false,
            "env.presets": false,

            // Optional: keep mixer + playback usable while testing
            "playback.basic": true,
            "playback.transport": true,
            "playback.shuffle": true,
            "playback.repeat": true,
            "mix.lanes": true,
            "ui.hide": true,
          },
        });

        // eslint-disable-next-line no-console
        console.log("[Dev] Harmony dev unlock OFF (persisted + live)");
      },
    });

    this.register("l", {
      label: "Toggle Owner (Lumen ↔ Director) — persisted",
      action: () => {
        this.bus.emit("dev:persistence:toggle-owner", { commit: true });
      },
    });

    // --------------------------------------------------------
    // Audio (Phase 1 skeleton) — DEV hotkeys
    // --------------------------------------------------------

    // Unlock browser audio (required before any sound can play)
    this.register("u", {
      label: "Unlock Audio (user gesture)",
      action: () => {
        this.bus.emit("audio:unlock-request", {});
      },
    });

    // Space toggles play/pause intent
    this.register(" ", {
      label: "Audio Toggle Play/Pause",
      action: () => {
        this.bus.emit("audio:toggle-request", {});
      },
    });

    // Volume down/up
    this.register("-", {
      label: "Audio Volume Down",
      action: () => {
        this.bus.emit("audio:volume-nudge", { delta: -0.05 });
      },
    });

    this.register("=", {
      label: "Audio Volume Up",
      action: () => {
        this.bus.emit("audio:volume-nudge", { delta: 0.05 });
      },
    });

    // Seek back/forward
    this.register("[", {
      label: "Audio Seek Back 5s",
      action: () => {
        this.bus.emit("audio:seek-nudge", { deltaSec: -5 });
      },
    });

    this.register("]", {
      label: "Audio Seek Forward 5s",
      action: () => {
        this.bus.emit("audio:seek-nudge", { deltaSec: 5 });
      },
    });

    // --------------------------------------------------------
    // Gate (Phase 1 DEV) — quick test hotkeys
    // --------------------------------------------------------
    // G: close the Still immediately (simulate midnight)
    // Shift+G: open the Still immediately (simulate ritual completion)
    //
    // We emit the GateSystem request events so there is zero coupling here.
    this.register("g", {
      label: "Gate Close (DEV) — simulate local midnight closure",
      when: (e) => !e.shiftKey,
      action: () => {
        this.bus.emit("gate:request-close", {});
        // eslint-disable-next-line no-console
        console.log("[Dev] Gate close requested");
      },
    });

    // NOTE: We reuse key="g" by overwriting only if shiftKey is true.
    // Because bindings map by key, we implement Shift+G as a second check
    // inside the same binding rather than a separate registration.
    // This avoids conflicts and keeps lookup O(1).
    const gBinding = this.bindings.get("g");
    if (gBinding) {
      const originalAction = gBinding.action;
      gBinding.action = (e: KeyboardEvent) => {
        if (e.shiftKey) {
          this.bus.emit("gate:request-open", {});
          // eslint-disable-next-line no-console
          console.log("[Dev] Gate open requested");
          return;
        }
        originalAction(e);
      };
      gBinding.label = "Gate Close/Open (DEV) — G close, Shift+G open";
      gBinding.when = undefined;
    }
  }
}