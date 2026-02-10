// src/systems/InteractionSystem.ts
// ============================================================
// THE STILL — InteractionSystem (MVP)
// ------------------------------------------------------------
// Responsibilities:
//  - Centralize pointer listeners (move/down)
//  - Raycast against current "pickables"
//  - Emit:
//      ui:hover (throttled on hover-enter)
//      ui:click (on successful hit)
//      interaction:hover:enter (object payload)
//      interaction:click (object payload)
//
// Input:
//  - Scenes set pickables via EventBus:
//      interaction:pickables:set { objects: THREE.Object3D[] }
//
// Notes:
//  - Keeps Engine clean (no UI hacks).
//  - Keeps scenes clean (no DOM listeners).
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";

export type InteractionPickablesSetPayload = {
  objects: THREE.Object3D[];
};

export type InteractionObjectPayload = {
  object: THREE.Object3D;
};

export class InteractionSystem {
  private readonly bus: EventBus;
  private readonly domElement: HTMLElement;

  private camera: THREE.Camera;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private pickables: THREE.Object3D[] = [];

  private hoveredUuid: string | null = null;

  // Hover SFX throttle (hover-enter only, but cooldown helps noisy devices)
  private lastHoverAt = 0;
  private readonly hoverCooldownMs = 140;

  private lastPointerClientX = 0;
  private lastPointerClientY = 0;
  private hasPointer = false;

  constructor(args: { bus: EventBus; domElement: HTMLElement; camera: THREE.Camera }) {
    this.bus = args.bus;
    this.domElement = args.domElement;
    this.camera = args.camera;

    // Subscribe to pickables
    this.bus.on<InteractionPickablesSetPayload>("interaction:pickables:set", this.onPickablesSet);

    // Pointer listeners
    this.domElement.addEventListener("pointermove", this.onPointerMove);
    this.domElement.addEventListener("pointerdown", this.onPointerDown);
  }

  /** If your active camera ever changes, call this. */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /** Optional: if you want hover to work even when the pointer is still, call this each frame. */
  update(_dt: number): void {
    // For now, we only raycast on pointermove.
    // If you later want "hover stays valid while camera moves", uncomment this:
    // if (this.hasPointer) this.raycastHover(this.lastPointerClientX, this.lastPointerClientY);
  }

  dispose(): void {
    this.bus.off("interaction:pickables:set", this.onPickablesSet);

    this.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);

    this.pickables = [];
    this.hoveredUuid = null;
  }

  // ---------------------------------------------------------------------------
  // EventBus
  // ---------------------------------------------------------------------------

  private onPickablesSet = (p: InteractionPickablesSetPayload): void => {
    const objects = Array.isArray(p?.objects) ? p.objects : [];
    this.pickables = objects;

    // Reset hover when pickables change
    this.hoveredUuid = null;
  };

  // ---------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    this.hasPointer = true;
    this.lastPointerClientX = e.clientX;
    this.lastPointerClientY = e.clientY;

    this.raycastHover(e.clientX, e.clientY);
  };

  private onPointerDown = (e: PointerEvent): void => {
    // Primary button only (left click / primary touch)
    if (typeof e.button === "number" && e.button !== 0) return;

    if (!this.pickables.length) return;

    const hit = this.raycastHit(e.clientX, e.clientY);
    if (!hit) return;

    // SFX hook
    this.bus.emit("ui:click", { kind: "click" });

    // Gameplay hook
    this.bus.emit("interaction:click", { object: hit.object } satisfies InteractionObjectPayload);
  };

  // ---------------------------------------------------------------------------
  // Raycast helpers
  // ---------------------------------------------------------------------------

  private raycastHover(clientX: number, clientY: number): void {
    if (!this.pickables.length) {
      this.hoveredUuid = null;
      return;
    }

    const hit = this.raycastHit(clientX, clientY);
    if (!hit) {
      this.hoveredUuid = null;
      return;
    }

    const uuid = hit.object.uuid;
    if (this.hoveredUuid === uuid) return;

    this.hoveredUuid = uuid;

    // SFX: hover-enter (throttled)
    const now = performance.now();
    if (now - this.lastHoverAt >= this.hoverCooldownMs) {
      this.lastHoverAt = now;
      this.bus.emit("ui:hover", { kind: "hover" });
    }

    // Gameplay hook
    this.bus.emit("interaction:hover:enter", { object: hit.object } satisfies InteractionObjectPayload);
  }

  private raycastHit(clientX: number, clientY: number): THREE.Intersection<THREE.Object3D> | null {
    // NDC coords (-1..+1)
    const rect = this.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);

    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(this.pickables, true);
    if (!hits.length) return null;

    return hits[0] ?? null;
  }
}
