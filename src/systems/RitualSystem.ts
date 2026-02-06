// src/systems/RitualSystem.ts
// ============================================================
// THE STILL — P03 (Ritual v0)
// RitualSystem
// ------------------------------------------------------------
// Responsibilities:
//  - Detect "hold the core" input (pointer or keyboard)
//  - Emit progress + completion events
//  - Lock camera controls during ritual
//
// Emits:
//  - ritual:core:hold-start
//  - ritual:core:progress
//  - ritual:core:cancelled
//  - ritual:core:completed
//
// Notes:
//  - Scene-owned (P03), event-driven
//  - Does NOT directly open the gate
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";

export type RitualCancelReason =
  | "pointer-up"
  | "pointer-leave"
  | "lost-focus"
  | "gate-opened"
  | "disabled";

export interface RitualSystemDeps {
  bus: EventBus;
  domElement: HTMLElement;
  camera: THREE.PerspectiveCamera;
  coreRoot: THREE.Object3D;
}

export interface RitualSystemOptions {
  holdDurationMs?: number; // default 3000 for dev
  enableKeyboardHold?: boolean;
}

type AudioSafeNumber = number;

const clamp01 = (v: AudioSafeNumber): number =>
  Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

const nowMs = (): number => Date.now();

export class RitualSystem {
  private readonly bus: EventBus;
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly coreRoot: THREE.Object3D;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private enabled = true;
  private holding = false;
  private usingKeyboard = false;

  private holdStartedAt = 0;
  private holdDurationMs: number;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerUp: () => void;
  private readonly onPointerLeave: () => void;
  private readonly onBlur: () => void;

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  constructor(deps: RitualSystemDeps, opts: RitualSystemOptions = {}) {
    this.bus = deps.bus;
    this.domElement = deps.domElement;
    this.camera = deps.camera;
    this.coreRoot = deps.coreRoot;

    this.holdDurationMs = Math.max(500, opts.holdDurationMs ?? 3000);

    // Bind handlers
    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onPointerLeave = this.handlePointerLeave.bind(this);
    this.onBlur = this.handleBlur.bind(this);

    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onKeyUp = this.handleKeyUp.bind(this);

    this.attachListeners(opts.enableKeyboardHold ?? true);

    // Gate reopening cancels ritual
    this.bus.on("gate:opened", () => {
      if (this.holding) this.cancel("gate-opened");
    });
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------

  public update(): void {
    if (!this.holding) return;

    const t = nowMs();
    const heldMs = t - this.holdStartedAt;
    const progress01 = clamp01(heldMs / this.holdDurationMs);

    this.bus.emit("ritual:core:progress", {
      atMs: t,
      heldMs,
      durationMs: this.holdDurationMs,
      progress01,
    });

    if (progress01 >= 1) {
      this.complete();
    }
  }

  public dispose(): void {
    this.detachListeners();
    if (this.holding) this.cancel("disabled");
  }

  // ------------------------------------------------------------
  // Input handling
  // ------------------------------------------------------------

  private handlePointerDown(e: PointerEvent): void {
    if (!this.enabled || this.holding) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!this.isPointerOnCore(e)) return;

    this.usingKeyboard = false;
    this.start();
  }

  private handlePointerUp(): void {
    if (!this.holding || this.usingKeyboard) return;
    this.cancel("pointer-up");
  }

  private handlePointerLeave(): void {
    if (!this.holding || this.usingKeyboard) return;
    this.cancel("pointer-leave");
  }

  private handleBlur(): void {
    if (!this.holding) return;
    this.cancel("lost-focus");
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.code !== "Space" || this.holding) return;
    this.usingKeyboard = true;
    this.start();
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.code !== "Space" || !this.holding || !this.usingKeyboard) return;
    this.cancel("pointer-up");
  }

  // ------------------------------------------------------------
  // Ritual lifecycle
  // ------------------------------------------------------------

  private start(): void {
    this.holding = true;
    this.holdStartedAt = nowMs();

    this.bus.emit("controls:set-locks", { rotate: true, zoom: true });

    this.bus.emit("ritual:core:hold-start", {
      atMs: this.holdStartedAt,
      durationMs: this.holdDurationMs,
    });
  }

  private cancel(reason: RitualCancelReason): void {
    const t = nowMs();
    const heldMs = t - this.holdStartedAt;

    this.holding = false;
    this.holdStartedAt = 0;
    this.usingKeyboard = false;

    this.bus.emit("controls:set-locks", { rotate: false, zoom: false });

    this.bus.emit("ritual:core:cancelled", {
      atMs: t,
      heldMs,
      reason,
    });
  }

  private complete(): void {
    const t = nowMs();
    const heldMs = t - this.holdStartedAt;

    this.holding = false;
    this.holdStartedAt = 0;
    this.usingKeyboard = false;

    this.bus.emit("controls:set-locks", { rotate: false, zoom: false });

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[Ritual] core completed");
    }

    this.bus.emit("ritual:core:completed", {
      atMs: t,
      heldMs,
      durationMs: this.holdDurationMs,
    });
  }

  // ------------------------------------------------------------
  // Core hit test
  // ------------------------------------------------------------

  private isPointerOnCore(e: PointerEvent): boolean {
    const rect = this.domElement.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    this.ndc.set(x * 2 - 1, -(y * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObject(this.coreRoot, true);
    return hits.some(h => h.object.name.startsWith("CoreSurface_"));
  }

  // ------------------------------------------------------------
  // Listener wiring
  // ------------------------------------------------------------

  private attachListeners(enableKeyboard: boolean): void {
    this.domElement.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    this.domElement.addEventListener("mouseleave", this.onPointerLeave);
    window.addEventListener("blur", this.onBlur);

    if (enableKeyboard) {
      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
    }
  }

  private detachListeners(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.domElement.removeEventListener("mouseleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onBlur);

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
