// src/systems/CameraSystem.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";

export type PolarConstraintMode = "clamp" | "wrap";

/**
 * Camera rig options for orbit behavior.
 *
 * IMPORTANT:
 * - "wrap" here means TRUE free-orbit via trackball math (no spherical poles).
 * - "clamp" is an optional framing mode that uses min/max polar angles
 *   relative to WORLD UP (classic orbit gate) for specific scenes.
 */
export interface CameraRigOptions {
  /** Minimum orbit distance from target */
  minDistance: number;
  /** Maximum orbit distance from target */
  maxDistance: number;

  /** Minimum polar angle (vertical) in radians (used when polarConstraintMode = "clamp") */
  minPolarAngle: number;
  /** Maximum polar angle (vertical) in radians (used when polarConstraintMode = "clamp") */
  maxPolarAngle: number;

  /**
   * How to constrain polar rotation:
   * - "wrap": FULL free-orbit trackball (no pole clamps, allows roll)
   * - "clamp": enforce min/max polar angles relative to WORLD UP
   */
  polarConstraintMode: PolarConstraintMode;

  /** Enable smooth damping */
  enableDamping: boolean;
  /** Damping factor (0–1, higher = more damping) */
  dampingFactor: number;
  /** Rotation speed in radians per pixel */
  rotateSpeed: number;
  /** Zoom speed scalar applied to wheel delta */
  zoomSpeed: number;
}

export interface CameraTelemetry {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
  azimuthAngle: number; // theta
  polarAngle: number; // phi
}

export interface CameraSystemDeps {
  camera: THREE.PerspectiveCamera;
  bus: EventBus;
  config: Config;
}

// Default: TRUE free-orbit (no gate, allows roll)
const DEFAULT_OPTIONS: CameraRigOptions = {
  minDistance: 40,
  maxDistance: 1979,

  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI - 0.1,

  polarConstraintMode: "wrap",

  enableDamping: true,
  dampingFactor: 0.15,

  rotateSpeed: (Math.PI / 180) * 0.0031,
  zoomSpeed: 0.00010,
};

export class CameraSystem {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly target: THREE.Vector3;
  public readonly options: CameraRigOptions;

  private readonly bus: EventBus;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly config: Config;

  // Orbit state is stored as an offset vector (trackball), not spherical angles.
  private readonly offset = new THREE.Vector3();

  // Accumulated deltas (from ControlSystem)
  private rotateDelta = new THREE.Vector2();
  private scale = 1;

  // Scratch (no allocations per frame)
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();

  private readonly qYaw = new THREE.Quaternion();
  private readonly qPitch = new THREE.Quaternion();

  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchTarget = new THREE.Vector3();

  constructor(deps: CameraSystemDeps) {
    this.camera = deps.camera;
    this.bus = deps.bus;
    this.config = deps.config;

    this.target = new THREE.Vector3(0, 0, 0);
    this.options = { ...DEFAULT_OPTIONS };

    // Initial camera placement matching your prior feel.
    // (radius ~12, above plane, looking toward origin)
    this.camera.position.set(0, 6, 12);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);

    // Initialize offset from current camera transform.
    this.offset.copy(this.camera.position).sub(this.target);

    // Clipping planes
    this.camera.near = 0.5;
    this.camera.far = 3500;
    this.camera.updateProjectionMatrix();

    this.registerBusHandlers();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public setTarget(target: THREE.Vector3): void {
    // Preserve camera world position by re-basing offset.
    const worldPos = this.camera.position.clone();
    this.target.copy(target);
    this.offset.copy(worldPos).sub(this.target);
  }

  public setOptions(partial: Partial<CameraRigOptions>): void {
    Object.assign(this.options, partial);
  }

  public applyControlDeltas(rotateDelta: THREE.Vector2, dollyDelta: number): void {
    if (rotateDelta.lengthSq() > 0) {
      this.rotateDelta.add(rotateDelta);
    }

    if (dollyDelta !== 0) {
      const zoomScale = Math.pow(0.95, dollyDelta * this.options.zoomSpeed);
      this.scale *= zoomScale;
    }
  }

  public update(deltaSeconds: number): void {
    // Ensure offset is valid
    if (this.offset.lengthSq() < 1e-10) {
      this.offset.set(0, 0, Math.max(this.options.minDistance, 12));
    }

    // -----------------------------------------------------------------------
    // Rotation (trackball)
    // -----------------------------------------------------------------------
    if (this.rotateDelta.lengthSq() > 0) {
      const yaw = -this.rotateDelta.x * this.options.rotateSpeed;
      const pitch = -this.rotateDelta.y * this.options.rotateSpeed;

      // Build an orthonormal camera basis from current orbit state.
      // forward points from camera toward target.
      this.scratchForward.copy(this.offset).normalize().multiplyScalar(-1);

      // Use current camera.up as the “local up” (allows roll in wrap mode).
      this.scratchUp.copy(this.camera.up).normalize();

      // right = forward x up
      this.scratchRight.copy(this.scratchForward).cross(this.scratchUp);

      // If nearly degenerate, fall back to a stable axis
      if (this.scratchRight.lengthSq() < 1e-10) {
        this.scratchRight.set(1, 0, 0);
      } else {
        this.scratchRight.normalize();
      }

      // Re-orthonormalize up = right x forward
      this.scratchUp.copy(this.scratchRight).cross(this.scratchForward).normalize();

      // Yaw around LOCAL up (not worldUp) to keep “keep rotating forever” feel.
      this.qYaw.setFromAxisAngle(this.scratchUp, yaw);

      // Pitch around LOCAL right
      this.qPitch.setFromAxisAngle(this.scratchRight, pitch);

      // Apply to offset
      this.offset.applyQuaternion(this.qYaw);
      this.offset.applyQuaternion(this.qPitch);

      // Apply to camera.up as well so roll is preserved (Variant A)
      this.camera.up.applyQuaternion(this.qYaw);
      this.camera.up.applyQuaternion(this.qPitch);
      this.camera.up.normalize();

      // Optional clamp mode: classic polar gate relative to WORLD UP
      if (this.options.polarConstraintMode === "clamp") {
        this.applyWorldPolarClamp();
      }
    }

    // -----------------------------------------------------------------------
    // Zoom (distance)
    // -----------------------------------------------------------------------
    let dist = this.offset.length();
    dist *= this.scale;
    dist = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
    this.offset.setLength(dist);

    // Commit camera transform
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    // Telemetry
    this.emitTelemetry();

    // Damping/reset
    if (this.options.enableDamping) {
      const damping = 1 - this.options.dampingFactor * Math.max(deltaSeconds, 0.016);
      this.rotateDelta.multiplyScalar(damping);
      this.scale = 1 + (this.scale - 1) * damping;
    } else {
      this.rotateDelta.set(0, 0);
      this.scale = 1;
    }
  }

  public getTelemetry(): CameraTelemetry {
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      distance: this.offset.length(),
      azimuthAngle: new THREE.Spherical().setFromVector3(this.offset).theta,
      polarAngle: new THREE.Spherical().setFromVector3(this.offset).phi,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal wiring
  // ---------------------------------------------------------------------------

  private registerBusHandlers(): void {
    this.bus.on("camera:set-target", (payload: { x: number; y: number; z: number }) => {
      this.setTarget(new THREE.Vector3(payload.x, payload.y, payload.z));
    });

    this.bus.on("camera:set-rig-options", (payload: Partial<CameraRigOptions>) => {
      this.setOptions(payload);
    });
  }

  /**
   * Only used when polarConstraintMode === "clamp".
   * This intentionally reintroduces a “gate” relative to WORLD UP for framed scenes.
   */
  private applyWorldPolarClamp(): void {
    const s = new THREE.Spherical().setFromVector3(this.offset);

    s.makeSafe();
    s.phi = Math.min(this.options.maxPolarAngle, Math.max(this.options.minPolarAngle, s.phi));

    // Rebuild offset with clamped phi while preserving theta/radius
    this.offset.setFromSpherical(s);

    // In clamp mode, also stabilize camera.up so the gate behaves predictably
    // (still doesn’t affect wrap mode).
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
