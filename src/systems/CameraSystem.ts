// src/systems/CameraSystem.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";

export interface CameraRigOptions {
  /** Minimum orbit distance from target */
  minDistance: number;
  /** Maximum orbit distance from target */
  maxDistance: number;
  /** Minimum polar angle (vertical) in radians */
  minPolarAngle: number;
  /** Maximum polar angle (vertical) in radians */
  maxPolarAngle: number;
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
  polarAngle: number;   // phi
}

export interface CameraSystemDeps {
  camera: THREE.PerspectiveCamera;
  bus: EventBus;
  config: Config;
}

// Tuned down for smoother, slower feel
const DEFAULT_OPTIONS: CameraRigOptions = {
  minDistance: 10,
  maxDistance: 500,
  minPolarAngle: 0.1,           // don't let the camera go exactly over the pole
  maxPolarAngle: Math.PI - 0.1, // don't flip upside down
  enableDamping: true,
  dampingFactor: 0.15,
  // ~0.06 degrees per pixel instead of ~0.25
  rotateSpeed: (Math.PI / 180) * 0.03,
  // Less aggressive zoom
  zoomSpeed: 0.0015,
};

export class CameraSystem {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly target: THREE.Vector3;
  public readonly options: CameraRigOptions;

  private readonly bus: EventBus;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly config: Config;

  // Spherical coordinates for orbit rig
  private spherical = new THREE.Spherical();
  private sphericalDelta = new THREE.Spherical(0, 0, 0);
  private scale = 1;

  // Scratch vectors to avoid allocations
  private readonly scratchOffset = new THREE.Vector3();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchTarget = new THREE.Vector3();

  constructor(deps: CameraSystemDeps) {
    this.camera = deps.camera;
    this.bus = deps.bus;
    this.config = deps.config;

    this.target = new THREE.Vector3(0, 0, 0);
    this.options = { ...DEFAULT_OPTIONS };

    // Initial camera placement: slightly above and back
    this.spherical.set(12, Math.PI / 3, 0); // radius, phi, theta
    this.updateCameraFromSpherical();

    this.registerBusHandlers();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set the orbit target in world space.
   * Future scenes can call via EventBus or direct method.
   */
  public setTarget(target: THREE.Vector3): void {
    this.target.copy(target);
    this.updateSphericalFromCamera();
  }

  /**
   * Patch current rig options (scene-specific profiles, etc.).
   */
  public setOptions(partial: Partial<CameraRigOptions>): void {
    Object.assign(this.options, partial);
  }

  /**
   * Apply raw control deltas (in pixels/scroll units) from the ControlSystem.
   * - rotateDelta: pixels of drag (x = horizontal, y = vertical)
   * - dollyDelta: wheel deltaY (positive = zoom out)
   */
  public applyControlDeltas(rotateDelta: THREE.Vector2, dollyDelta: number): void {
    if (rotateDelta.lengthSq() > 0) {
      this.sphericalDelta.theta -= rotateDelta.x * this.options.rotateSpeed;
      this.sphericalDelta.phi -= rotateDelta.y * this.options.rotateSpeed;
    }

    if (dollyDelta !== 0) {
      // Zoom by scaling radius; smaller factor per "tick" for smoothness
      const zoomScale = Math.pow(0.95, dollyDelta * this.options.zoomSpeed);
      this.scale *= zoomScale;
    }
  }

  /**
   * Call once per frame from Engine / SceneManager.
   * deltaSeconds is used by damping for smoothness.
   */
  public update(deltaSeconds: number): void {
    // Apply rotation deltas
    this.spherical.theta += this.sphericalDelta.theta;
    this.spherical.phi += this.sphericalDelta.phi;

    // Clamp vertical angle
    this.spherical.makeSafe();
    this.spherical.phi = Math.min(
      this.options.maxPolarAngle,
      Math.max(this.options.minPolarAngle, this.spherical.phi),
    );

    // Apply zoom scale
    this.spherical.radius *= this.scale;
    this.spherical.radius = Math.min(
      this.options.maxDistance,
      Math.max(this.options.minDistance, this.spherical.radius),
    );

    // Commit updated camera transform
    this.updateCameraFromSpherical();

    // Emit telemetry for DebugOverlay / HUD
    this.emitTelemetry();

    // Damping or reset
    if (this.options.enableDamping) {
      const damping = 1 - this.options.dampingFactor * Math.max(deltaSeconds, 0.016);
      this.sphericalDelta.theta *= damping;
      this.sphericalDelta.phi *= damping;
      this.scale = 1 + (this.scale - 1) * damping;
    } else {
      this.sphericalDelta.theta = 0;
      this.sphericalDelta.phi = 0;
      this.scale = 1;
    }
  }

  /**
   * Current camera telemetry snapshot. Useful for HUDs that want direct access
   * instead of listening on the EventBus.
   */
  public getTelemetry(): CameraTelemetry {
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      distance: this.spherical.radius,
      azimuthAngle: this.spherical.theta,
      polarAngle: this.spherical.phi,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal wiring
  // ---------------------------------------------------------------------------

  private registerBusHandlers(): void {
    // Scene-level control: set target
    this.bus.on("camera:set-target", (payload: { x: number; y: number; z: number }) => {
      this.target.set(payload.x, payload.y, payload.z);
      this.updateSphericalFromCamera();
    });

    // Scene-level control: patch rig options
    this.bus.on("camera:set-rig-options", (payload: Partial<CameraRigOptions>) => {
      this.setOptions(payload);
    });
  }

  private updateCameraFromSpherical(): void {
    this.scratchOffset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(this.scratchOffset);
    this.camera.lookAt(this.target);
  }

  private updateSphericalFromCamera(): void {
    this.scratchOffset.copy(this.camera.position).sub(this.target);
    this.spherical.setFromVector3(this.scratchOffset);
  }

  private emitTelemetry(): void {
    this.scratchPosition.copy(this.camera.position);
    this.scratchTarget.copy(this.target);

    const telemetry: CameraTelemetry = {
      position: this.scratchPosition.clone(),
      target: this.scratchTarget.clone(),
      distance: this.spherical.radius,
      azimuthAngle: this.spherical.theta,
      polarAngle: this.spherical.phi,
    };

    this.bus.emit("camera:telemetry", telemetry);
  }
}
