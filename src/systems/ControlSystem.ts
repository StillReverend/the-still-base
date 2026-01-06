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
  dollyDelta: number; // wheel-like deltaY sum (positive = zoom out)
}

type PointerInfo = {
  id: number;
  pos: THREE.Vector2;
  prev: THREE.Vector2;
  type: PointerEvent["pointerType"];
};

type PointerMode = "rotate" | "pinch" | null;

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

  // Accumulated deltas consumed each frame
  private rotateDelta = new THREE.Vector2();
  private dollyDelta = 0;

  // Pointer state (supports mouse + touch)
  private pointers: Map<number, PointerInfo> = new Map();
  private pointerMode: PointerMode = null;

  // Mouse rotate convenience
  private mouseActiveId: number | null = null;
  private lastMouse = new THREE.Vector2();

  // Pinch state
  private lastPinchDistance = 0;

  // Tuning: how strongly pinch distance maps to dollyDelta
  // Larger = faster zoom from pinch.
  private readonly pinchZoomFactor = 1.0;

  // Wheel handling
  private readonly preventPageScrollOnWheel = true;

  constructor(deps: ControlSystemDeps) {
    this.domElement = deps.domElement;
    this.bus = deps.bus;
    this.config = deps.config;

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerCancel = this.handlePointerCancel.bind(this);
    this.handleWheel = this.handleWheel.bind(this);

    this.attachEventListeners();
    this.registerBusHandlers();

    // Recommended so mobile gestures are delivered to us (not browser zoom/scroll)
    this.domElement.style.touchAction = "none";
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
    window.addEventListener("pointercancel", this.handlePointerCancel);
    this.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private detachEventListeners(): void {
    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    this.domElement.removeEventListener("wheel", this.handleWheel);
  }

  private handlePointerDown(ev: PointerEvent): void {
    if (!this.enabled) return;

    const info: PointerInfo = {
      id: ev.pointerId,
      pos: new THREE.Vector2(ev.clientX, ev.clientY),
      prev: new THREE.Vector2(ev.clientX, ev.clientY),
      type: ev.pointerType,
    };

    this.pointers.set(ev.pointerId, info);

    try {
      this.domElement.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    // Mouse: left button rotate
    if (ev.pointerType === "mouse") {
      if (ev.button !== 0) return;
      this.pointerMode = "rotate";
      this.mouseActiveId = ev.pointerId;
      this.lastMouse.set(ev.clientX, ev.clientY);
      return;
    }

    // Touch / pen:
    // If we now have 2 pointers, enter pinch mode.
    if (this.pointers.size === 2) {
      this.pointerMode = "pinch";
      this.lastPinchDistance = this.getPinchDistance();
      // Stop any mouse state just in case.
      this.mouseActiveId = null;
      return;
    }

    // Otherwise, 1 pointer = rotate mode (touch drag)
    if (this.pointers.size === 1) {
      this.pointerMode = "rotate";
    }
  }

  private handlePointerMove(ev: PointerEvent): void {
    if (!this.enabled) return;

    const info = this.pointers.get(ev.pointerId);
    if (!info) return;

    info.prev.copy(info.pos);
    info.pos.set(ev.clientX, ev.clientY);

    // If two touches are down, prioritize pinch zoom.
    if (this.pointerMode === "pinch" && this.pointers.size === 2) {
      if (this.locks.zoom) return;

      const dist = this.getPinchDistance();
      const dd = dist - this.lastPinchDistance;
      this.lastPinchDistance = dist;

      // Convert pinch distance delta into "wheel-like" dollyDelta.
      // Positive dollyDelta zooms OUT in our CameraSystem contract.
      //
      // When fingers move apart (dd > 0), user expects zoom IN -> dollyDelta should be negative.
      // When fingers move together (dd < 0), user expects zoom OUT -> dollyDelta should be positive.
      this.dollyDelta += (dd) * this.pinchZoomFactor;

      return;
    }

    // Rotate mode: mouse or single-touch drag.
    if (this.pointerMode === "rotate") {
      if (this.locks.rotate) return;

      // Mouse rotate (active pointer)
      if (ev.pointerType === "mouse") {
        if (this.mouseActiveId !== ev.pointerId) return;

        const dx = ev.clientX - this.lastMouse.x;
        const dy = ev.clientY - this.lastMouse.y;

        this.rotateDelta.x += dx;
        this.rotateDelta.y += dy;

        this.lastMouse.set(ev.clientX, ev.clientY);
        return;
      }

      // Touch rotate: use per-pointer delta
      const dx = info.pos.x - info.prev.x;
      const dy = info.pos.y - info.prev.y;

      this.rotateDelta.x += dx;
      this.rotateDelta.y += dy;
    }
  }

  private handlePointerUp(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);

    try {
      this.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    if (this.mouseActiveId === ev.pointerId) {
      this.mouseActiveId = null;
    }

    // Mode transitions
    if (this.pointers.size >= 2) {
      this.pointerMode = "pinch";
      this.lastPinchDistance = this.getPinchDistance();
    } else if (this.pointers.size === 1) {
      this.pointerMode = "rotate";
    } else {
      this.pointerMode = null;
    }
  }

  private handlePointerCancel(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);

    if (this.mouseActiveId === ev.pointerId) {
      this.mouseActiveId = null;
    }

    // Reset if cancelled
    if (this.pointers.size === 0) {
      this.pointerMode = null;
      this.lastPinchDistance = 0;
    }
  }

  private handleWheel(ev: WheelEvent): void {
    if (!this.enabled || this.locks.zoom) return;

    if (this.preventPageScrollOnWheel) {
      ev.preventDefault();
    }

    this.dollyDelta += -ev.deltaY;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getPinchDistance(): number {
    // Only valid when exactly 2 pointers exist.
    const it = this.pointers.values();
    const a = it.next().value as PointerInfo | undefined;
    const b = it.next().value as PointerInfo | undefined;
    if (!a || !b) return 0;
    return a.pos.distanceTo(b.pos);
  }
}
