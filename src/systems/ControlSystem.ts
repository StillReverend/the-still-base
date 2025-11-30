// src/systems/ControlSystem.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";

export interface ControlSystemDeps {
  domElement: HTMLElement;
  bus: EventBus;
  config: Config;
}

/**
 * Which parts of the control surface are currently locked.
 * Scenes can selectively lock rotation or zoom.
 */
export interface ControlLocks {
  rotate: boolean;
  zoom: boolean;
}

/**
 * Snapshot of accumulated deltas since the last frame.
 * Engine / CameraSystem should call consumeSnapshot() once per tick.
 */
export interface ControlSnapshot {
  rotateDelta: THREE.Vector2; // drag movement in screen pixels
  dollyDelta: number;         // wheel deltaY sum
}

type PointerMode = "rotate" | null;

export class ControlSystem {
  private readonly domElement: HTMLElement;
  private readonly bus: EventBus;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly config: Config;

  private enabled = true;
  private locks: ControlLocks = {
    rotate: false,
    zoom: false,
  };

  private pointerActive = false;
  private pointerMode: PointerMode = null;
  private lastPointer = new THREE.Vector2();

  private rotateDelta = new THREE.Vector2();
  private dollyDelta = 0;

  constructor(deps: ControlSystemDeps) {
    this.domElement = deps.domElement;
    this.bus = deps.bus;
    this.config = deps.config;

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);

    this.attachEventListeners();
    this.registerBusHandlers();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Whether the control surface responds to input at all.
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Patch locks (e.g., a scene can lock zoom or rotation).
   */
  public setLocks(partial: Partial<ControlLocks>): void {
    this.locks = { ...this.locks, ...partial };
  }

  /**
   * Consume & reset the accumulated deltas since the last call.
   * Should be called once per frame from the Engine / CameraSystem owner.
   */
  public consumeSnapshot(): ControlSnapshot {
    const snapshot: ControlSnapshot = {
      rotateDelta: this.rotateDelta.clone(),
      dollyDelta: this.dollyDelta,
    };

    this.rotateDelta.set(0, 0);
    this.dollyDelta = 0;

    return snapshot;
  }

  /**
   * Clean up all event listeners when tearing down the engine.
   */
  public dispose(): void {
    this.detachEventListeners();
  }

  // ---------------------------------------------------------------------------
  // EventBus wiring
  // ---------------------------------------------------------------------------

  private registerBusHandlers(): void {
    this.bus.on("controls:set-enabled", (enabled: boolean) => {
      this.enabled = Boolean(enabled);
    });

    this.bus.on("controls:set-locks", (payload: Partial<ControlLocks>) => {
      this.setLocks(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // DOM event handling
  // ---------------------------------------------------------------------------

  private attachEventListeners(): void {
    this.domElement.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    this.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private detachEventListeners(): void {
    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    this.domElement.removeEventListener("wheel", this.handleWheel);
  }

  private handlePointerDown(ev: PointerEvent): void {
    if (!this.enabled) return;
    if (ev.button !== 0) return; // left button only for now

    this.pointerActive = true;
    this.pointerMode = "rotate";
    this.lastPointer.set(ev.clientX, ev.clientY);

    try {
      this.domElement.setPointerCapture(ev.pointerId);
    } catch {
      // Some browsers may throw if capture isn't supported; safe to ignore.
    }
  }

  private handlePointerMove(ev: PointerEvent): void {
    if (!this.enabled || !this.pointerActive) return;
    if (this.pointerMode !== "rotate" || this.locks.rotate) return;

    const dx = ev.clientX - this.lastPointer.x;
    const dy = ev.clientY - this.lastPointer.y;

    this.rotateDelta.x += dx;
    this.rotateDelta.y += dy;

    this.lastPointer.set(ev.clientX, ev.clientY);
  }

  private handlePointerUp(ev: PointerEvent): void {
    if (!this.pointerActive) return;

    this.pointerActive = false;
    this.pointerMode = null;

    try {
      this.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      // Safe to ignore if capture wasn't set or not supported.
    }
  }

  private handleWheel(ev: WheelEvent): void {
    if (!this.enabled || this.locks.zoom) return;

    // Prevent the page from scrolling while zooming the camera.
    ev.preventDefault();

    this.dollyDelta += ev.deltaY;
  }
}
