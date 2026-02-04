import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { Config } from "../core/Config";

export type PolarConstraintMode = "clamp" | "wrap";

/**
 * Camera rig options for orbit behavior.
 *
 * IMPORTANT:
 * - "wrap" here means TRUE free-orbit trackball math (no spherical poles).
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
   * - "wrap": FULL free-orbit trackball math (no spherical poles, allows roll)
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

  // ---------------------------------------------------------------------------
  // Auto-orbit (drift)
  // ---------------------------------------------------------------------------

  /** Whether auto-orbit drift is enabled */
  autoOrbitEnabled: boolean;

  /**
   * Seconds of no user input before auto-orbit begins.
   *
   * NOTE:
   * Kept for backward compatibility. In the “time cannot be stopped” mode,
   * orbit drift is constant and this value is ignored.
   */
  autoOrbitDelaySeconds: number;

  /** Auto-orbit yaw speed in radians per second (applied around local-up) */
  autoOrbitSpeedRadPerSec: number;

  // ---------------------------------------------------------------------------
  // Auto-dolly (idle fly in/out between two distances)
  // ---------------------------------------------------------------------------

  /** Whether idle dolly is enabled */
  autoDollyEnabled: boolean;

  /** Seconds of no user input before dolly begins (orbit drift can already be running). */
  autoDollyDelaySeconds: number;

  /** Near distance target for the idle dolly (world units). */
  autoDollyNearDistance: number;

  /** Far distance target for the idle dolly (world units). */
  autoDollyFarDistance: number;

  /**
   * Seconds to travel from near -> far (and far -> near).
   * Higher = slower, more serene conductor-wand motion.
   */
  autoDollySecondsPerLeg: number;
}

// Default: TRUE free-orbit (no gate, allows roll)
const DEFAULT_OPTIONS: CameraRigOptions = {
  minDistance: 103.1,
  maxDistance: 10000,

  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI - 0.1,

  polarConstraintMode: "wrap",

  enableDamping: true,
  dampingFactor: 0.50,

  rotateSpeed: (Math.PI / 180) * 0.0031,
  zoomSpeed: 0.0001,

  // Auto-orbit defaults (tweak via bus.emit("camera:set-rig-options", {...}))
  autoOrbitEnabled: true,
  autoOrbitDelaySeconds: 0.0, // ignored (orbit drift is constant)
  autoOrbitSpeedRadPerSec: 0.031,

  // Auto-dolly defaults (idle fly in/out)
  autoDollyEnabled: true,
  autoDollyDelaySeconds: 10,
  autoDollyNearDistance: 103.1,
  autoDollyFarDistance: 1031,
  autoDollySecondsPerLeg: 79,
};

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

  // Idle tracking for auto behaviors
  private idleSeconds = 0;

  // Tracks REAL user input (not damping residual).
  // This fixes the case where rotate/zoom damping keeps the system from ever becoming "idle".
  private hadUserInputThisFrame = false;
  private secondsSinceUserInput = 9999;

  // Auto-dolly state
  private autoDollyWasActive = false;
  private autoDollyTime = 0;

  // NEW: capture start distance so dolly begins exactly where we are (no snap),
  // and ALWAYS starts by moving outward toward far.
  private autoDollyStartDistance = 0;
  private autoDollyFirstLegSeconds = 0;

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
    this.camera.position.set(0, 6, 12);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);

    // Initialize offset from current camera transform.
    this.offset.copy(this.camera.position).sub(this.target);

    // Clipping planes
    this.camera.near = 0.5;
    this.camera.far = 15000;
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

    // Switching targets counts as “activity”
    this.idleSeconds = 0;

    // Force a clean re-entry into idle dolly on next idle frame
    this.autoDollyWasActive = false;
    this.autoDollyTime = 0;
  }

  public setOptions(partial: Partial<CameraRigOptions>): void {
    Object.assign(this.options, partial);

    // Keep values sane
    if (this.options.autoOrbitDelaySeconds < 0) this.options.autoOrbitDelaySeconds = 0;
    if (this.options.autoOrbitSpeedRadPerSec < 0) this.options.autoOrbitSpeedRadPerSec = 0;

    if (this.options.autoDollyDelaySeconds < 0) this.options.autoDollyDelaySeconds = 0;
    if (this.options.autoDollySecondsPerLeg < 0.1) this.options.autoDollySecondsPerLeg = 0.1;

    // Prevent inverted ranges
    if (this.options.autoDollyFarDistance < this.options.autoDollyNearDistance) {
      const tmp = this.options.autoDollyFarDistance;
      this.options.autoDollyFarDistance = this.options.autoDollyNearDistance;
      this.options.autoDollyNearDistance = tmp;
    }
  }

  public applyControlDeltas(rotateDelta: THREE.Vector2, dollyDelta: number): void {
    let hadUserInput = false;

    if (rotateDelta.lengthSq() > 0) {
      this.rotateDelta.add(rotateDelta);
      hadUserInput = true;
    }

    if (dollyDelta !== 0) {
      const zoomScale = Math.pow(0.95, dollyDelta * this.options.zoomSpeed);
      this.scale *= zoomScale;
      hadUserInput = true;
    }

    if (hadUserInput) {
      // Any intentional camera interaction cancels idle timers (but time drift continues)
      this.idleSeconds = 0;

      // IMPORTANT: allow auto-dolly to re-arm after user interaction
      this.autoDollyWasActive = false;
    }
  }

  public update(deltaSeconds: number): void {
    // Clamp deltaSeconds just to avoid weird spikes if tab was backgrounded
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);

    // Ensure offset is valid
    if (this.offset.lengthSq() < 1e-10) {
      this.offset.set(0, 0, Math.max(this.options.minDistance, 12));
    }

    // Track idleness based on REAL user input (not damping residual).
    // This prevents rotate/zoom damping from keeping us "non-idle" forever.
    if (!this.hadUserInputThisFrame) {
      this.secondsSinceUserInput += dt;
      this.idleSeconds += dt;
    } else {
      // A fresh input event happened this frame (mouse/touch/wheel).
      this.secondsSinceUserInput = 0;
      this.idleSeconds = 0;
    }

    // Consider the user "actively controlling" only if input occurred THIS frame.
    // Damping/inertia should not block idle behaviors from resuming.
    const hasActiveUserMotion = this.hadUserInputThisFrame;

    // Orbit drift is CONSTANT when enabled.
    const autoOrbitActive = this.options.autoOrbitEnabled;

    // Dolly should be delayed by inactivity (independent of orbit drift).
    const autoDollyActive =
      this.options.autoDollyEnabled &&
      !hasActiveUserMotion &&
      this.idleSeconds >= this.options.autoDollyDelaySeconds;

    // -----------------------------------------------------------------------
    // Auto-orbit injection (constant drift)
    // -----------------------------------------------------------------------
    if (autoOrbitActive) {
      const yaw = this.options.autoOrbitSpeedRadPerSec * dt;

      // Build an orthonormal camera basis from current orbit state.
      this.scratchForward.copy(this.offset).normalize().multiplyScalar(-1);
      this.scratchUp.copy(this.camera.up).normalize();
      this.scratchRight.copy(this.scratchForward).cross(this.scratchUp);

      if (this.scratchRight.lengthSq() < 1e-10) {
        this.scratchRight.set(1, 0, 0);
      } else {
        this.scratchRight.normalize();
      }

      this.scratchUp.copy(this.scratchRight).cross(this.scratchForward).normalize();

      // Yaw about LOCAL up
      this.qYaw.setFromAxisAngle(this.scratchUp, yaw);

      this.offset.applyQuaternion(this.qYaw);
      this.camera.up.applyQuaternion(this.qYaw);
      this.camera.up.normalize();

      if (this.options.polarConstraintMode === "clamp") {
        this.applyWorldPolarClamp();
      }
    }

    // -----------------------------------------------------------------------
    // Rotation (trackball) from user deltas
    // -----------------------------------------------------------------------
    if (this.rotateDelta.lengthSq() > 0) {
      const yaw = -this.rotateDelta.x * this.options.rotateSpeed;
      const pitch = -this.rotateDelta.y * this.options.rotateSpeed;

      // Build an orthonormal camera basis from current orbit state.
      this.scratchForward.copy(this.offset).normalize().multiplyScalar(-1);
      this.scratchUp.copy(this.camera.up).normalize();
      this.scratchRight.copy(this.scratchForward).cross(this.scratchUp);

      if (this.scratchRight.lengthSq() < 1e-10) {
        this.scratchRight.set(1, 0, 0);
      } else {
        this.scratchRight.normalize();
      }

      this.scratchUp.copy(this.scratchRight).cross(this.scratchForward).normalize();

      // Yaw around LOCAL up
      this.qYaw.setFromAxisAngle(this.scratchUp, yaw);
      // Pitch around LOCAL right
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
    // Auto-dolly (idle fly out first, then in, repeating)
    // -----------------------------------------------------------------------
    if (autoDollyActive) {
      // On activation: start EXACTLY at current distance (no jump)
      // and ALWAYS move outward first (toward far).
      if (!this.autoDollyWasActive) {
        this.autoDollyTime = 0;

        const currentDist = this.offset.length();
        this.autoDollyStartDistance = Math.min(
          this.options.maxDistance,
          Math.max(this.options.minDistance, currentDist),
        );

        // Precompute first-leg duration so velocity feels consistent even if we start mid-span.
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

        // Scale first leg time proportionally so speed doesn't change.
        const secondsPerLeg = Math.max(0.1, this.options.autoDollySecondsPerLeg);
        this.autoDollyFirstLegSeconds = secondsPerLeg * (firstSpan / baseSpan);

        // If we're essentially already at far, skip the first leg.
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

      // Easing curve for serene turning at the endpoints.
      // Smoothstep: 3t^2 - 2t^3 (C1 continuous, no jolty corner)
      const ease = (t: number): number => t * t * (3 - 2 * t);

      let targetDist = this.offset.length();

      // Leg 0: start -> far (outward first)
      if (this.autoDollyFirstLegSeconds > 0 && this.autoDollyTime < this.autoDollyFirstLegSeconds) {
        const t = this.autoDollyTime / this.autoDollyFirstLegSeconds; // 0..1
        targetDist = THREE.MathUtils.lerp(
          this.autoDollyStartDistance,
          farDist,
          ease(THREE.MathUtils.clamp(t, 0, 1)),
        );
      } else {
        // After leg 0, continue with repeating legs of fixed duration:
        // leg 1: far -> near
        // leg 2: near -> far
        // ...
        const tAfter = this.autoDollyTime - this.autoDollyFirstLegSeconds;
        const leg = Math.floor(tAfter / secondsPerLeg);
        const tLeg = (tAfter % secondsPerLeg) / secondsPerLeg; // 0..1
        const t = ease(THREE.MathUtils.clamp(tLeg, 0, 1));

        targetDist =
          leg % 2 === 0
            ? THREE.MathUtils.lerp(farDist, nearDist, t) // leg 0 here == far->near
            : THREE.MathUtils.lerp(nearDist, farDist, t); // leg 1 here == near->far
      }

      this.offset.setLength(targetDist);
    }

    // -----------------------------------------------------------------------
    // Zoom (distance)
    // -----------------------------------------------------------------------
    let dist = this.offset.length();

    // Apply dolly scale only if it actually moved this frame.
    if (Math.abs(this.scale - 1) > 1e-6) {
      dist *= this.scale;
      dist = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
      this.offset.setLength(dist);
    } else {
      // Still ensure distance clamps (in case options changed)
      dist = Math.min(this.options.maxDistance, Math.max(this.options.minDistance, dist));
      this.offset.setLength(dist);
    }

    // Track whether dolly was active last frame (for clean enter/exit)
    this.autoDollyWasActive = autoDollyActive;
    if (!autoDollyActive) {
      this.autoDollyTime = 0;
      this.autoDollyFirstLegSeconds = 0;
    }

    // Commit camera transform
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    // Telemetry
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

    // Clear per-frame input flag.
    this.hadUserInputThisFrame = false;
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
