// src/systems/CameraDirectorSystem.ts
// ============================================================
// THE STILL — CameraDirectorSystem (P03.2)
// ------------------------------------------------------------
// Responsibilities:
//  - Provide named, cinematic camera transitions ("shots").
//  - Own interruption/queue policy.
//  - Take/return control from CameraSystem cleanly (handoff to orbit).
//
// MVP shots:
//  - "flyTo": fly toward a target while smoothly steering lookAt.
//  - "arcTo": orbit-state arc using orbit params (wraps classic orbit tween).
//
// Events:
//  - camera:play    { name, params, policy? }
//  - camera:stop    { reason? }
//  - camera:playing { name }
//  - camera:stopped { name?, reason? }
//
// Notes:
//  - We keep this system fully Engine-owned (single instance).
//  - CameraSystem remains the “rig”; Director is the “brain”.
//  - Director owns "who we are currently orbiting" (identity), not scenes.
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import { gsap } from "../core/Motion";
import type { CameraSystem, CameraSetOrbitPayload } from "./CameraSystem";

export type CameraPlayPolicy = "interrupt" | "queue" | "ignore";

export type ShotName = "flyTo" | "arcTo";

/**
 * IMPORTANT:
 *  - targetId is a semantic identifier (CORE, CONSTELLATION:3, etc.)
 *  - This enables "ignore re-click on current orbit target" and future puzzle routing.
 */
export type CameraPlayPayload =
  | {
      name: "flyTo";
      params: FlyToParams;
      policy?: CameraPlayPolicy;
    }
  | {
      name: "arcTo";
      params: ArcToParams;
      policy?: CameraPlayPolicy;
    };

export type CameraStopPayload = {
  reason?: string;
};

export type FlyToParams = {
  targetId?: string;

  target: { x: number; y: number; z: number };
  distance: number;

  duration?: number; // seconds
  ease?: string; // GSAP ease (used for internal time curve)

  up?: { x: number; y: number; z: number }; // camera up during flight + orbit handoff
  lookLag?: number; // 0..1, higher = faster orientation convergence
};

export type ArcToParams = {
  targetId?: string;

  target: { x: number; y: number; z: number };
  distance: number;
  theta: number;
  phi: number;

  duration?: number; // seconds
  ease?: string; // GSAP ease name
  up?: { x: number; y: number; z: number };
};

type ActiveShot =
  | {
      name: "flyTo";
      kind: "flyTo";
      startedAt: number;
      duration: number;
      ease: (t: number) => number;

      targetId: string | null;

      startPos: THREE.Vector3;
      endPos: THREE.Vector3;

      target: THREE.Vector3;
      up: THREE.Vector3;
      lookLag: number;
    }
  | {
      name: "arcTo";
      kind: "arcTo";
      targetId: string | null;

      tween: gsap.core.Tween;
      orbitState: CameraSetOrbitPayload; // driven by tween
      up: THREE.Vector3;
      finalOrbit: CameraSetOrbitPayload;
    };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function easeFromGsapName(name: string): (t: number) => number {
  // Minimal mapping: we only need a safe curve.
  // If an unknown name appears, we default to a pleasant ease.
  switch (name) {
    case "linear":
      return (t) => t;
    case "power1.out":
      return (t) => 1 - Math.pow(1 - t, 1);
    case "power2.out":
      return (t) => 1 - Math.pow(1 - t, 2);
    case "power3.out":
      return (t) => 1 - Math.pow(1 - t, 3);
    case "power4.out":
      return (t) => 1 - Math.pow(1 - t, 4);
    case "power2.inOut":
      return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    default:
      return (t) => 1 - Math.pow(1 - t, 2);
  }
}

function asSemanticId(maybeId: unknown): string | null {
  if (typeof maybeId !== "string") return null;
  const id = maybeId.trim();
  if (!id) return null;
  return id;
}

export class CameraDirectorSystem {
  private readonly bus: EventBus;
  private readonly cameraSystem: CameraSystem;

  private active: ActiveShot | null = null;
  private queue: CameraPlayPayload[] = [];

  private isCinematic = false;

  /**
   * Director-owned identity for "what we are currently orbiting".
   * This is the canonical answer for:
   *  - should we ignore re-click on same object?
   *  - what should puzzle click routing use later?
   */
  private activeOrbitTargetId: string | null = null;

  // scratch (no per-frame allocations)
  private readonly vTarget = new THREE.Vector3();
  private readonly vUp = new THREE.Vector3();
  private readonly vPos = new THREE.Vector3();
  private readonly vDir = new THREE.Vector3();
  private readonly mLook = new THREE.Matrix4();
  private readonly qDesired = new THREE.Quaternion();
  private readonly qCurrent = new THREE.Quaternion();

  private onPlay = (payload: CameraPlayPayload): void => {
    const policy: CameraPlayPolicy = payload?.policy ?? "interrupt";

    // Guard: if request is to "play to" the thing we are already orbiting, ignore.
    // This is the safety net even if click routing forgets to check.
    const requestedId =
      payload?.name === "flyTo"
        ? asSemanticId(payload.params?.targetId)
        : asSemanticId(payload.params?.targetId);

    if (requestedId && requestedId === this.activeOrbitTargetId) {
      return;
    }

    // If a shot is active, apply policy.
    if (this.active) {
      if (policy === "ignore") return;
      if (policy === "queue") {
        this.queue.push(payload);
        return;
      }
      // interrupt
      this.stopActive("interrupt");
    }

    this.startShot(payload);
  };

  private onStop = (payload: CameraStopPayload): void => {
    const reason = payload?.reason ?? "stop";
    this.stopActive(reason);
    this.queue = [];
  };

  constructor(deps: { bus: EventBus; cameraSystem: CameraSystem }) {
    this.bus = deps.bus;
    this.cameraSystem = deps.cameraSystem;

    this.bus.on<CameraPlayPayload>("camera:play", this.onPlay);
    this.bus.on<CameraStopPayload>("camera:stop", this.onStop);
  }

  // ---------------------------------------------------------------------------
  // Public: identity (for click routers / puzzles)
  // ---------------------------------------------------------------------------

  public getActiveOrbitTargetId(): string | null {
    return this.activeOrbitTargetId;
  }

  public isOrbitingTarget(id: string): boolean {
    return this.activeOrbitTargetId === id;
  }

  update(dt: number): void {
    if (!this.active) return;

    // Ensure rig is in cinematic mode while a shot is active.
    if (!this.isCinematic) {
      this.isCinematic = true;
      this.cameraSystem.setCinematicActive(true);
      this.bus.emit("camera:playing", { name: this.active.name });
    }

    if (this.active.kind === "flyTo") {
      const now = performance.now() / 1000;
      const t01 = clamp01((now - this.active.startedAt) / this.active.duration);
      const t = this.active.ease(t01);

      // Position interpolation
      this.vPos.lerpVectors(this.active.startPos, this.active.endPos, t);

      // Orientation: look at target, but with “steering” lag
      const cam = this.cameraSystem.camera;

      this.qCurrent.copy(cam.quaternion);

      this.mLook.lookAt(this.vPos, this.active.target, this.active.up);
      this.qDesired.setFromRotationMatrix(this.mLook);

      // lookLag: convert to a per-frame blend factor.
      // - If lookLag = 1: converge quickly.
      // - If lookLag small: more floaty steering.
      const lag = clamp01(this.active.lookLag);
      const steer = clamp01(1 - Math.pow(1 - lag, Math.max(1, dt * 60)));

      cam.quaternion.slerpQuaternions(this.qCurrent, this.qDesired, steer);
      cam.position.copy(this.vPos);
      cam.up.copy(this.active.up);

      // Commit pose to rig (so telemetry and handoff are consistent)
      this.cameraSystem.applyCinematicPose(cam.position, cam.quaternion, cam.up);

      if (t01 >= 1) {
        // Hand off into orbit around target at the landed pose
        this.cameraSystem.handoffToOrbitTarget(this.active.target, this.active.up);

        // IMPORTANT: update identity only on successful completion
        if (this.active.targetId) this.activeOrbitTargetId = this.active.targetId;

        this.stopActive("complete");
        this.playNextFromQueueIfAny();
      }
      return;
    }

    if (this.active.kind === "arcTo") {
      // CameraSystem is being driven through orbit set calls via tween onUpdate.
      // We just wait for the tween to complete (it calls stopActive).
      return;
    }
  }

  dispose(): void {
    this.stopActive("dispose");
    this.queue = [];

    this.bus.off("camera:play", this.onPlay as unknown as (payload: unknown) => void);
    this.bus.off("camera:stop", this.onStop as unknown as (payload: unknown) => void);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private playNextFromQueueIfAny(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;

    // If queued shot tries to go to current orbit target, skip it.
    const requestedId =
      next.name === "flyTo" ? asSemanticId(next.params.targetId) : asSemanticId(next.params.targetId);
    if (requestedId && requestedId === this.activeOrbitTargetId) {
      this.playNextFromQueueIfAny();
      return;
    }

    this.startShot(next);
  }

  private stopActive(reason: string): void {
    if (!this.active) {
      if (this.isCinematic) {
        this.isCinematic = false;
        this.cameraSystem.setCinematicActive(false);
      }
      return;
    }

    const stopping = this.active;

    if (stopping.kind === "arcTo") {
      stopping.tween.kill();
    }

    this.active = null;

    // Return rig control (unless a new shot starts immediately)
    if (this.isCinematic) {
      this.isCinematic = false;
      this.cameraSystem.setCinematicActive(false);
    }

    this.bus.emit("camera:stopped", { name: stopping.name, reason });
  }

  private startShot(payload: CameraPlayPayload): void {
    if (!payload || !payload.name) return;

    switch (payload.name) {
      case "flyTo":
        this.startFlyTo(payload.params);
        return;

      case "arcTo":
        this.startArcTo(payload.params);
        return;

      default:
        // eslint-disable-next-line no-console
        console.warn(`[CameraDirector] Unknown shot name: ${String((payload as any)?.name)}`);
        return;
    }
  }

  private startFlyTo(params: FlyToParams): void {
    const cam = this.cameraSystem.camera;

    const duration = typeof params?.duration === "number" ? Math.max(0.05, params.duration) : 1.05;
    const easeName = typeof params?.ease === "string" ? params.ease : "power2.out";
    const ease = easeFromGsapName(easeName);

    const distance = Math.max(1, params?.distance ?? 300);

    this.vTarget.set(params.target.x, params.target.y, params.target.z);

    const up = params?.up ?? { x: cam.up.x, y: cam.up.y, z: cam.up.z };
    this.vUp.set(up.x, up.y, up.z);
    if (this.vUp.lengthSq() < 1e-10) this.vUp.set(0, 1, 0);
    else this.vUp.normalize();

    // End position: keep approach direction from current camera toward target,
    // then land at the requested distance.
    this.vDir.subVectors(cam.position, this.vTarget);
    if (this.vDir.lengthSq() < 1e-10) this.vDir.set(0, 0, 1);
    this.vDir.normalize();

    const endPos = new THREE.Vector3().copy(this.vTarget).addScaledVector(this.vDir, distance);

    const targetId = asSemanticId(params?.targetId);

    this.active = {
      name: "flyTo",
      kind: "flyTo",
      startedAt: performance.now() / 1000,
      duration,
      ease,

      targetId,

      startPos: cam.position.clone(),
      endPos,
      target: this.vTarget.clone(),
      up: this.vUp.clone(),
      lookLag: typeof params?.lookLag === "number" ? clamp01(params.lookLag) : 0.22,
    };

    // Take control immediately
    this.isCinematic = true;
    this.cameraSystem.setCinematicActive(true);
    this.bus.emit("camera:playing", { name: "flyTo" });
  }

  private startArcTo(params: ArcToParams): void {
    // ArcTo is cinematic, implemented by tweening orbit state and applying via CameraSystem.

    const cam = this.cameraSystem.camera;

    // Seed FROM current orbit state via cameraSystem telemetry (stable API)
    const tel = this.cameraSystem.getTelemetry();

    const from: CameraSetOrbitPayload = {
      target: { x: tel.target.x, y: tel.target.y, z: tel.target.z },
      distance: tel.distance,
      theta: tel.azimuthAngle,
      phi: tel.polarAngle,
      up: { x: cam.up.x, y: cam.up.y, z: cam.up.z },
    };

    const to: CameraSetOrbitPayload = {
      target: params.target,
      distance: params.distance,
      theta: params.theta,
      phi: params.phi,
      up: params.up ?? from.up,
    };

    const duration = typeof params?.duration === "number" ? Math.max(0.05, params.duration) : 1.05;
    const ease = typeof params?.ease === "string" ? params.ease : "power2.out";

    // Up (normalize)
    const up = to.up ?? { x: cam.up.x, y: cam.up.y, z: cam.up.z };
    this.vUp.set(up.x, up.y, up.z);
    if (this.vUp.lengthSq() < 1e-10) this.vUp.set(0, 1, 0);
    else this.vUp.normalize();

    const orbitState: CameraSetOrbitPayload = {
      target: { ...from.target },
      distance: from.distance,
      theta: from.theta,
      phi: from.phi,
      up: { x: this.vUp.x, y: this.vUp.y, z: this.vUp.z },
    };

    const targetId = asSemanticId(params?.targetId);

    // Take control (rig should not drift/dolly while we arc)
    this.isCinematic = true;
    this.cameraSystem.setCinematicActive(true);
    this.bus.emit("camera:playing", { name: "arcTo" });

    const tween = gsap.to(orbitState, {
      target: to.target as any,
      distance: to.distance,
      theta: to.theta,
      phi: to.phi,
      duration,
      ease,
      onUpdate: () => {
        this.cameraSystem.setOrbitInstantPublic(orbitState);
      },
      onComplete: () => {
        // Ensure final state is applied cleanly
        this.cameraSystem.setOrbitInstantPublic(to);

        // IMPORTANT: update identity only on successful completion
        if (targetId) this.activeOrbitTargetId = targetId;

        // We are already in orbit; just release cinematic lock
        this.stopActive("complete");
        this.playNextFromQueueIfAny();
      },
    });

    this.active = {
      name: "arcTo",
      kind: "arcTo",
      targetId,

      tween,
      orbitState,
      up: this.vUp.clone(),
      finalOrbit: to,
    };
  }
}
