// src/systems/CameraSystem.ts
// ============================================================
// THE STILL — CameraSystem (Rig)
// ------------------------------------------------------------
// Responsibilities:
//  - Own the live camera "rig" state (orbit target + offset).
//  - Apply user input deltas (rotate/zoom).
//  - Apply idle behaviors (auto-orbit, auto-dolly).
//  - Provide a clean cinematic handoff surface for CameraDirectorSystem.
//  - Emit telemetry.
//
// Explicit non-goals (Director-owned):
//  - No cinematic tweens/timelines live here.
//  - No "transition-to-orbit" event.
//  - No direct scene camera driving.
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";

export type PolarConstraintMode = "clamp" | "wrap";

export interface CameraRigOptions {
  minDistance: number;
  maxDistance: number;

  minPolarAngle: number;
  maxPolarAngle: number;

  polarConstraintMode: PolarConstraintMode;

  enableDamping: boolean;
  dampingFactor: number;
  rotateSpeed: number;
  zoomSpeed: number;

  autoOrbitEnabled: boolean;
  autoOrbitDelaySeconds: number; // (reserved; not used yet, but kept for future)
  autoOrbitSpeedRadPerSec: number;

  autoDollyEnabled: boolean;
  autoDollyDelaySeconds: number;
  autoDollyNearDistance: number;
  autoDollyFarDistance: number;
  autoDollySecondsPerLeg: number;
}

const DEFAULT_OPTIONS: CameraRigOptions = {
  minDistance: 200,
  maxDistance: 10000,

  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI - 0.1,

  polarConstraintMode: "wrap",

  enableDamping: true,
  dampingFactor: 0.5,

  rotateSpeed: (Math.PI / 180) * 0.0031,
  zoomSpeed: 0.0001,

  autoOrbitEnabled: true,
  autoOrbitDelaySeconds: 0.0,
  autoOrbitSpeedRadPerSec: 0.020,

  autoDollyEnabled: true,
  autoDollyDelaySeconds: 30,
  autoDollyNearDistance: 231,
  autoDollyFarDistance: 2026,
  autoDollySecondsPerLeg: 31,
};

export interface CameraTelemetry {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
  azimuthAngle: number;
  polarAngle: number;
}

export interface CameraSystemDeps {
  camera: THREE.PerspectiveCamera;
  bus: EventBus;
  config: Config;
}

export type CameraSetOrbitPayload = {
  target: { x: number; y: number; z: number };
  distance: number;
  theta: number;
  phi: number;
  up?: { x: number; y: number; z: number };
};

export class CameraSystem {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly target: THREE.Vector3;
  public readonly options: CameraRigOptions;

  private readonly bus: EventBus;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly config: Config;

  // Orbit state stored as offset vector (world space)
  private readonly offset = new THREE.Vector3();

  // Buffered per-frame input
  private rotateDelta = new THREE.Vector2();
  private scale = 1;

  // Idle tracking
  private idleSeconds = 0;
  private hadUserInputThisFrame = false;

  // Auto-dolly state
  private autoDollyWasActive = false;
  private autoDollyTime = 0;
  private autoDollyStartDistance = 0;
  private autoDollyFirstLegSeconds = 0;

  // Director lock
  private cinematicActive = false;

  // Scratch / constants
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();

  private readonly qYaw = new THREE.Quaternion();
  private readonly qPitch = new THREE.Quaternion();

  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchTarget = new THREE.Vector3();

  private readonly scratchUpVec = new THREE.Vector3();
  private readonly scratchSpherical = new THREE.Spherical();

  constructor(deps: CameraSystemDeps) {
    this.camera = deps.camera;
    this.bus = deps.bus;
    this.config = deps.config;

    this.target = new THREE.Vector3(0, 0, 0);
    this.options = { ...DEFAULT_OPTIONS };

    // Seed camera
    this.camera.position.set(0, 6, 12);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);

    // Seed orbit offset
    this.offset.copy(this.camera.position).sub(this.target);

    // Camera clip planes (Engine may override far/near too)
    this.camera.near = 0.5;
    this.camera.far = 15000;
    this.camera.updateProjectionMatrix();

    this.registerBusHandlers();
  }

  // ---------------------------------------------------------------------------
  // Public API (Director + Engine)
  // ---------------------------------------------------------------------------

  /** Director lock. When active, the rig will not apply input/idle behaviors. */
  public setCinematicActive(active: boolean): void {
    this.cinematicActive = active;

    // Always clear buffered motion so we don't "snap" on the first free rig frame.
    this.rotateDelta.set(0, 0);
    this.scale = 1;

    this.idleSeconds = 0;
    this.autoDollyWasActive = false;
    this.autoDollyTime = 0;
    this.autoDollyFirstLegSeconds = 0;
    this.hadUserInputThisFrame = false;

    if (!active) {
      // Re-anchor orbit state to current camera pose so resuming is seamless.
      this.offset.copy(this.camera.position).sub(this.target);
      if (this.offset.lengthSq() < 1e-10) {
        this.offset.set(0, 0, Math.max(this.options.minDistance, 12));
      }

      const dist = this.offset.length();
      const clamped = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
      this.offset.setLength(clamped);

      this.camera.position.copy(this.target).add(this.offset);
      this.camera.lookAt(this.target);
    }
  }

  /**
   * Director writes the exact pose and asks the rig to "accept" it as truth.
   * This keeps telemetry stable and makes the handoff deterministic.
   */
  public applyCinematicPose(position: THREE.Vector3, quaternion: THREE.Quaternion, up: THREE.Vector3): void {
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    this.camera.up.copy(up);

    this.offset.copy(this.camera.position).sub(this.target);
  }

  /**
   * Director finished a shot and wants orbit control around a target using the
   * CURRENT camera position as the initial orbit offset.
   */
  public handoffToOrbitTarget(target: THREE.Vector3, up?: THREE.Vector3): void {
    this.target.copy(target);

    this.offset.copy(this.camera.position).sub(this.target);
    if (this.offset.lengthSq() < 1e-10) {
      this.offset.set(0, 0, Math.max(this.options.minDistance, 12));
    }

    const dist = this.offset.length();
    const clamped = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
    this.offset.setLength(clamped);

    if (up) {
      this.camera.up.copy(up);
      if (this.camera.up.lengthSq() < 1e-10) this.camera.up.set(0, 1, 0);
      else this.camera.up.normalize();
    }

    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    this.rotateDelta.set(0, 0);
    this.scale = 1;

    this.idleSeconds = 0;
    this.autoDollyWasActive = false;
    this.autoDollyTime = 0;
    this.autoDollyFirstLegSeconds = 0;
    this.hadUserInputThisFrame = false;
  }

  /**
   * Public wrapper used by the Director to set orbit state instantly.
   * (We keep the public name explicit to discourage scenes from calling private APIs.)
   */
  public setOrbitInstantPublic(p: CameraSetOrbitPayload): void {
    this.setOrbitInstant(p);
  }

  /** Engine/scenes may set rig options (not pose). */
  public setOptions(partial: Partial<CameraRigOptions>): void {
    Object.assign(this.options, partial);

    if (this.options.autoOrbitDelaySeconds < 0) this.options.autoOrbitDelaySeconds = 0;
    if (this.options.autoOrbitSpeedRadPerSec < 0) this.options.autoOrbitSpeedRadPerSec = 0;

    if (this.options.autoDollyDelaySeconds < 0) this.options.autoDollyDelaySeconds = 0;
    if (this.options.autoDollySecondsPerLeg < 0.1) this.options.autoDollySecondsPerLeg = 0.1;

    if (this.options.autoDollyFarDistance < this.options.autoDollyNearDistance) {
      const tmp = this.options.autoDollyFarDistance;
      this.options.autoDollyFarDistance = this.options.autoDollyNearDistance;
      this.options.autoDollyNearDistance = tmp;
    }
  }

  /**
   * ControlSystem feeds deltas here; rig applies them during update().
   * NOTE: This is ignored during cinematic.
   */
  public applyControlDeltas(rotateDelta: THREE.Vector2, dollyDelta: number): void {
    if (this.cinematicActive) return;

    let hadUserInput = false;

    if (rotateDelta.lengthSq() > 0) {
      this.rotateDelta.add(rotateDelta);
      hadUserInput = true;
      this.hadUserInputThisFrame = true;
    }

    if (dollyDelta !== 0) {
      const zoomScale = Math.pow(0.95, dollyDelta * this.options.zoomSpeed);
      this.scale *= zoomScale;
      hadUserInput = true;
      this.hadUserInputThisFrame = true;
    }

    if (hadUserInput) {
      this.idleSeconds = 0;
      this.autoDollyWasActive = false;
    }
  }

  public update(deltaSeconds: number): void {
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);

    if (this.cinematicActive) {
      this.emitTelemetry();
      this.hadUserInputThisFrame = false;
      return;
    }

    if (this.offset.lengthSq() < 1e-10) {
      this.offset.set(0, 0, Math.max(this.options.minDistance, 12));
    }

    // Idle tracking
    if (!this.hadUserInputThisFrame) this.idleSeconds += dt;
    else this.idleSeconds = 0;

    const hasActiveUserMotion = this.hadUserInputThisFrame;

    const autoOrbitActive = this.options.autoOrbitEnabled;

    const autoDollyActive =
      this.options.autoDollyEnabled &&
      !hasActiveUserMotion &&
      this.idleSeconds >= this.options.autoDollyDelaySeconds;

    // -----------------------------------------------------------------------
    // Auto-orbit drift
    // -----------------------------------------------------------------------
    if (autoOrbitActive) {
      const yaw = this.options.autoOrbitSpeedRadPerSec * dt;

      this.scratchForward.copy(this.offset).normalize().multiplyScalar(-1);
      this.scratchUp.copy(this.camera.up).normalize();
      this.scratchRight.copy(this.scratchForward).cross(this.scratchUp);

      if (this.scratchRight.lengthSq() < 1e-10) {
        this.scratchRight.set(1, 0, 0);
      } else {
        this.scratchRight.normalize();
      }

      this.scratchUp.copy(this.scratchRight).cross(this.scratchForward).normalize();

      this.qYaw.setFromAxisAngle(this.scratchUp, yaw);

      this.offset.applyQuaternion(this.qYaw);
      this.camera.up.applyQuaternion(this.qYaw);
      this.camera.up.normalize();

      if (this.options.polarConstraintMode === "clamp") {
        this.applyWorldPolarClamp();
      }
    }

    // -----------------------------------------------------------------------
    // Rotation from user deltas
    // -----------------------------------------------------------------------
    if (this.rotateDelta.lengthSq() > 0) {
      const yaw = -this.rotateDelta.x * this.options.rotateSpeed;
      const pitch = -this.rotateDelta.y * this.options.rotateSpeed;

      this.scratchForward.copy(this.offset).normalize().multiplyScalar(-1);
      this.scratchUp.copy(this.camera.up).normalize();
      this.scratchRight.copy(this.scratchForward).cross(this.scratchUp);

      if (this.scratchRight.lengthSq() < 1e-10) {
        this.scratchRight.set(1, 0, 0);
      } else {
        this.scratchRight.normalize();
      }

      this.scratchUp.copy(this.scratchRight).cross(this.scratchForward).normalize();

      this.qYaw.setFromAxisAngle(this.scratchUp, yaw);
      this.qPitch.setFromAxisAngle(this.scratchRight, pitch);

      this.offset.applyQuaternion(this.qYaw);
      this.offset.applyQuaternion(this.qPitch);

      this.camera.up.applyQuaternion(this.qYaw);
      this.camera.up.applyQuaternion(this.qPitch);
      this.camera.up.normalize();

      if (this.options.polarConstraintMode === "clamp") {
        this.applyWorldPolarClamp();
      }
    }

    // -----------------------------------------------------------------------
    // Auto-dolly (distance breathing)
    // -----------------------------------------------------------------------
    if (autoDollyActive) {
      if (!this.autoDollyWasActive) {
        this.autoDollyTime = 0;

        const currentDist = this.offset.length();
        this.autoDollyStartDistance = Math.min(
          this.options.maxDistance,
          Math.max(this.options.minDistance, currentDist),
        );

        const nearDistRaw = this.options.autoDollyNearDistance;
        const farDistRaw = this.options.autoDollyFarDistance;

        const nearDist = Math.min(
          this.options.maxDistance,
          Math.max(this.options.minDistance, nearDistRaw),
        );
        const farDist = Math.min(
          this.options.maxDistance,
          Math.max(this.options.minDistance, farDistRaw),
        );

        const baseSpan = Math.max(1e-6, Math.abs(farDist - nearDist));
        const firstSpan = Math.abs(farDist - this.autoDollyStartDistance);

        const secondsPerLeg = Math.max(0.1, this.options.autoDollySecondsPerLeg);
        this.autoDollyFirstLegSeconds = secondsPerLeg * (firstSpan / baseSpan);

        if (this.autoDollyFirstLegSeconds < 1e-3) {
          this.autoDollyFirstLegSeconds = 0;
        }
      }

      this.autoDollyTime += dt;

      const secondsPerLeg = Math.max(0.1, this.options.autoDollySecondsPerLeg);

      const nearDistRaw = this.options.autoDollyNearDistance;
      const farDistRaw = this.options.autoDollyFarDistance;

      const nearDist = Math.min(
        this.options.maxDistance,
        Math.max(this.options.minDistance, nearDistRaw),
      );
      const farDist = Math.min(
        this.options.maxDistance,
        Math.max(this.options.minDistance, farDistRaw),
      );

      const ease = (t: number): number => t * t * (3 - 2 * t);

      let targetDist = this.offset.length();

      if (this.autoDollyFirstLegSeconds > 0 && this.autoDollyTime < this.autoDollyFirstLegSeconds) {
        const t = this.autoDollyTime / this.autoDollyFirstLegSeconds;
        targetDist = THREE.MathUtils.lerp(
          this.autoDollyStartDistance,
          farDist,
          ease(THREE.MathUtils.clamp(t, 0, 1)),
        );
      } else {
        const tAfter = this.autoDollyTime - this.autoDollyFirstLegSeconds;
        const leg = Math.floor(tAfter / secondsPerLeg);
        const tLeg = (tAfter % secondsPerLeg) / secondsPerLeg;
        const t = ease(THREE.MathUtils.clamp(tLeg, 0, 1));

        targetDist =
          leg % 2 === 0
            ? THREE.MathUtils.lerp(farDist, nearDist, t)
            : THREE.MathUtils.lerp(nearDist, farDist, t);
      }

      this.offset.setLength(targetDist);
    }

    // -----------------------------------------------------------------------
    // Zoom (distance) from input scale
    // -----------------------------------------------------------------------
    let dist = this.offset.length();

    if (Math.abs(this.scale - 1) > 1e-6) {
      dist *= this.scale;
    }

    dist = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
    this.offset.setLength(dist);

    this.autoDollyWasActive = autoDollyActive;
    if (!autoDollyActive) {
      this.autoDollyTime = 0;
      this.autoDollyFirstLegSeconds = 0;
    }

    // Commit camera transform
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    this.emitTelemetry();

    // Damping/reset
    if (this.options.enableDamping) {
      const damping = 1 - this.options.dampingFactor * Math.max(dt, 0.016);
      this.rotateDelta.multiplyScalar(damping);
      this.scale = 1 + (this.scale - 1) * damping;
    } else {
      this.rotateDelta.set(0, 0);
      this.scale = 1;
    }

    this.hadUserInputThisFrame = false;
  }

  public getTelemetry(): CameraTelemetry {
    const s = new THREE.Spherical().setFromVector3(this.offset);
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      distance: this.offset.length(),
      azimuthAngle: s.theta,
      polarAngle: s.phi,
    };
  }

  // ---------------------------------------------------------------------------
  // Bus wiring
  // ---------------------------------------------------------------------------

  private registerBusHandlers(): void {
    this.bus.on("camera:set-rig-options", (payload: Partial<CameraRigOptions>) => {
      this.setOptions(payload);
    });

    this.bus.on<CameraSetOrbitPayload>("camera:set-orbit", (payload) => {
      this.setOrbitInstant(payload);
    });
  }

  // ---------------------------------------------------------------------------
  // Orbit set (instant)
  // ---------------------------------------------------------------------------

  private setOrbitInstant(p: CameraSetOrbitPayload): void {
    const up = p.up ?? { x: this.camera.up.x, y: this.camera.up.y, z: this.camera.up.z };

    this.target.set(p.target.x, p.target.y, p.target.z);

    this.scratchUpVec.set(up.x, up.y, up.z);
    if (this.scratchUpVec.lengthSq() < 1e-10) this.scratchUpVec.set(0, 1, 0);
    else this.scratchUpVec.normalize();
    this.camera.up.copy(this.scratchUpVec);

    const dist = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, p.distance));

    this.scratchSpherical.radius = dist;
    this.scratchSpherical.theta = p.theta;
    this.scratchSpherical.phi = p.phi;
    this.scratchSpherical.makeSafe();

    this.offset.setFromSpherical(this.scratchSpherical);

    if (this.options.polarConstraintMode === "clamp") {
      this.applyWorldPolarClamp();
    }

    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    this.rotateDelta.set(0, 0);
    this.scale = 1;

    this.idleSeconds = 0;
    this.autoDollyWasActive = false;
    this.hadUserInputThisFrame = false;
  }

  private applyWorldPolarClamp(): void {
    const s = new THREE.Spherical().setFromVector3(this.offset);

    s.makeSafe();
    s.phi = Math.min(this.options.maxPolarAngle, Math.max(this.options.minPolarAngle, s.phi));

    this.offset.setFromSpherical(s);
    this.camera.up.copy(this.worldUp);
  }

  private emitTelemetry(): void {
    this.scratchPos.copy(this.camera.position);
    this.scratchTarget.copy(this.target);

    const s = new THREE.Spherical().setFromVector3(this.offset);

    const telemetry: CameraTelemetry = {
      position: this.scratchPos.clone(),
      target: this.scratchTarget.clone(),
      distance: this.offset.length(),
      azimuthAngle: s.theta,
      polarAngle: s.phi,
    };

    this.bus.emit("camera:telemetry", telemetry);
  }
}
