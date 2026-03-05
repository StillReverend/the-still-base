// src/systems/ParticleFXSystem.ts
// ============================================================
// THE STILL — ParticleFXSystem (Router-only: BAND morph modes)
// ------------------------------------------------------------
// Updated direction (per your clarified vision):
//  - ALL particle looks (embers, dust, rain, snow, etc.) are morph states of BAND points.
//  - ParticleFXSystem does NOT spawn separate particle point clouds.
//  - ParticleFXSystem routes Harmony particle selections into FieldFXSystem.setMode().
//
// What remains here:
//  - Engine-owned singleton (one instance per app)
//  - Owns debug mounts (camera/field/local roots) for visualization + future expansion
//  - Listens to Harmony environment snapshots (canonical truth)
//  - (Optional) local volume API is kept for compatibility, but currently not implemented
//    because your current vision is a global BAND morph, not per-anchor emitters.
//
// IMPORTANT (Mar 2026 fix):
//  - We DO NOT apply mode changes on toggle *intent* events.
//  - We ONLY apply mode changes on canonical snapshots:
//      harmony:environment:state / harmony:environment:changed
//    This prevents 1-frame "flash" transitions from intermediate intent states.
// ============================================================

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import { FieldFXSystem, type FieldFXMode } from "./fieldfx/FieldFXSystem";

type AnyFn = (...args: any[]) => void;

type HarmonyEnvironmentSnapshot = {
  particles?: Record<string, boolean>;
  state?: { particles?: Record<string, boolean> };
  environment?: { particles?: Record<string, boolean> };
  reason?: string;
};

type ToggleParticleIntent = {
  particleId: string;
  enabled: boolean;
};

type ParticleMode = "camera" | "field";

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------

const isFiniteNumber = (v: number): boolean => Number.isFinite(v) && !Number.isNaN(v);

const safeString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

// Preferred priority when multiple toggles are true.
// (Harmony may allow multiple toggles; we choose one “active mode” deterministically.)
//
// IMPORTANT: We do NOT default to "stars" when nothing is selected.
// Stars is an explicit selection (particles.stars === true).
const FIELD_MODE_PRIORITY: Array<Exclude<FieldFXMode, "stars">> = [
  "embers",
  "dust",
  "fireflies",
  "leaves",
  "rain",
  "snow",
];

// Returns:
//  - a concrete FieldFXMode when we have an explicit selection
//  - null when nothing is selected (TRUE OFF state; disable FieldFX / BAND morph)
function pickFieldModeFromParticles(raw: unknown): FieldFXMode | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;

  // Highest-priority non-stars modes
  for (const k of FIELD_MODE_PRIORITY) {
    if (m[k] === true) return k;
  }

  // Stars is explicit, not a fallback
  if (m.stars === true) return "stars";

  // No selection: true OFF
  return null;
}

// ------------------------------------------------------------
// ParticleFXSystem
// ------------------------------------------------------------

export interface ParticleFXSystemDeps {
  bus: EventBus;
}

type LocalRegisterPayload = {
  anchorId: string;
  parent: THREE.Object3D;
};

type LocalUnregisterPayload = {
  anchorId: string;
};

type LocalSetPayload = {
  anchorId: string;
  particleId: string;
  enabled: boolean;
};

type LocalApplyPayload = {
  anchorId: string;
  particles: Record<string, boolean>;
};

type LocalClearPayload = {
  anchorId: string;
};

type MountKind = "camera" | "field" | "local";

type ParticleMount = {
  kind: MountKind;
  id: string;
  root: THREE.Group;
};

const CAMERA_MOUNT_ID = "camera";
const FIELD_MOUNT_ID = "field";

const DEFAULT_DEBUG_RADIUS = 22;
const MIN_CAMERA_OFFSET = 10;

export class ParticleFXSystem {
  private readonly bus: EventBus;

  private initialized = false;
  private disposers: Array<() => void> = [];

  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;

  private cameraMount: ParticleMount | null = null;
  private fieldMount: ParticleMount | null = null;
  private localMounts = new Map<string, ParticleMount>();

  // FIELD is the new default (you can still switch to camera via event)
  private mode: ParticleMode = "field";

  // ------------------------------------------------------------
  // FieldFX (BAND router)
  // ------------------------------------------------------------

  private readonly fieldFX: FieldFXSystem;

  // Cached last-known Harmony particle toggles (canonical within router)
  private lastParticles: Record<string, boolean> = {};

  // Track last mode we actually applied to FieldFX (for debug + stability)
  private lastAppliedMode: FieldFXMode | null = null;

  // ------------------------------------------------------------
  // Camera-mount behavior tuning (debug mount positioning)
  // ------------------------------------------------------------

  private cameraForwardOffset = 30;

  private tmpPos = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();

  // ------------------------------------------------------------
  // Debug marker (DEV only, active mount)
  // ------------------------------------------------------------

  private debugEnabled = false;
  private debugMarker: THREE.Mesh | null = null;

  private debugBoundsEnabled = false;
  private debugBounds: THREE.LineSegments | null = null;

  constructor(deps: ParticleFXSystemDeps) {
    this.bus = deps.bus;

    // Single “router” for BAND starfield mode swaps (stars <-> embers/dust/fireflies/leaves/rain/snow/etc)
    this.fieldFX = new FieldFXSystem({ bus: this.bus });
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // ✅ Canonical truth only (prevents intermediate flash states)
    this.on<HarmonyEnvironmentSnapshot>("harmony:environment:state", (p) => this.onEnvironmentSnapshot(p, "state"));
    this.on<HarmonyEnvironmentSnapshot>("harmony:environment:changed", (p) =>
      this.onEnvironmentSnapshot(p, "changed"),
    );

    // NOTE: We intentionally ignore toggle intent events for applying FieldFX mode.
    // They can arrive before persistence normalization/snapshot and cause 1-frame flashes.
    // We keep listeners only for optional debug logging.
    this.on<ToggleParticleIntent>("harmony:environment:toggleParticle", (p) => this.onToggleIntentDebug(p));
    this.on<ToggleParticleIntent>("harmony:env:toggleParticle", (p) => this.onToggleIntentDebug(p));

    this.on<{ enabled: boolean }>("particlefx:debug:set", (p) => this.setDebug(Boolean(p?.enabled)));
    this.on<{ enabled: boolean }>("particlefx:debug-bounds:set", (p) => this.setDebugBounds(Boolean(p?.enabled)));

    // Debug mount mode (camera/field). This does NOT affect FieldFX.
    this.on<{ mode: ParticleMode }>("particlefx:mode:set", (p) => {
      const next: ParticleMode = p?.mode === "camera" ? "camera" : "field";
      this.setMode(next);
    });

    // Local volume API (compat/future)
    this.on<LocalRegisterPayload>("particlefx:local:register", (p) => this.onLocalRegister(p));
    this.on<LocalUnregisterPayload>("particlefx:local:unregister", (p) => this.onLocalUnregister(p));
    this.on<LocalSetPayload>("particlefx:local:set", (p) => this.onLocalSet(p));
    this.on<LocalApplyPayload>("particlefx:local:apply", (p) => this.onLocalApply(p));
    this.on<LocalClearPayload>("particlefx:local:clear", (p) => this.onLocalClear(p));
  }

  public setTargets(scene: THREE.Scene | null, camera: THREE.Camera | null): void {
    if (this.scene === scene && this.camera === camera) return;

    this.detachMountFromScene(this.cameraMount);
    this.detachMountFromScene(this.fieldMount);

    this.scene = scene;
    this.camera = camera;

    // Forward to FieldFX router
    if (this.scene && this.camera) {
      this.fieldFX.setTargets(this.scene, this.camera);
    }

    if (!this.scene || !this.camera) {
      this.removeDebugMarker();
      this.removeDebugBounds();
      return;
    }

    if (!this.cameraMount) {
      this.cameraMount = this.createMount("camera", CAMERA_MOUNT_ID);
      this.cameraMount.root.name = "ParticleFXRoot_Camera";
    }

    if (!this.fieldMount) {
      this.fieldMount = this.createMount("field", FIELD_MOUNT_ID);
      this.fieldMount.root.name = "ParticleFXRoot_Field";
    }

    // Compute forward offset based on camera.near (if available)
    const camAny = this.camera as unknown as { near?: number };
    const near = typeof camAny.near === "number" && isFiniteNumber(camAny.near) ? camAny.near : 0.1;
    this.cameraForwardOffset = Math.max(MIN_CAMERA_OFFSET, near * 6);

    this.attachActiveMount();
    this.refreshDebugAttachments();
  }

  public update(dt: number): void {
    // 1) Update FIELD FX router (BAND morph)
    this.fieldFX.update(dt);

    // 2) Update debug mount transforms (only affects debug visuals, not FieldFX)
    const active = this.getActiveMount();
    if (active && this.camera) {
      if (active.kind === "camera") {
        this.camera.getWorldPosition(this.tmpPos);
        this.camera.getWorldQuaternion(this.tmpQuat);
        this.camera.getWorldDirection(this.tmpDir);

        active.root.position.copy(this.tmpPos).add(this.tmpDir.multiplyScalar(this.cameraForwardOffset));
        active.root.quaternion.copy(this.tmpQuat);
      } else if (active.kind === "field") {
        // FIELD: follow camera position only, no rotation
        this.camera.getWorldPosition(this.tmpPos);
        active.root.position.copy(this.tmpPos);
        active.root.quaternion.identity();
      }
    }
  }

  public setMode(mode: ParticleMode): void {
    const next: ParticleMode = mode === "camera" ? "camera" : "field";
    if (this.mode === next) return;

    this.mode = next;

    if (this.scene) {
      this.attachActiveMount();
      this.refreshDebugAttachments();
    }

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[ParticleFX] debug mount mode -> ${this.mode}`);
    }
  }

  public setDebug(enabled: boolean): void {
    const next = enabled === true;
    if (this.debugEnabled === next) return;

    this.debugEnabled = next;
    if (!import.meta.env.DEV) return;

    this.refreshDebugAttachments();
  }

  public setDebugBounds(enabled: boolean): void {
    const next = enabled === true;
    if (this.debugBoundsEnabled === next) return;

    this.debugBoundsEnabled = next;
    if (!import.meta.env.DEV) return;

    this.refreshDebugAttachments();
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.initialized = false;

    // FieldFX router
    this.fieldFX.dispose();

    for (const m of this.localMounts.values()) {
      if (m.root.parent) m.root.parent.remove(m.root);
    }
    this.localMounts.clear();

    if (this.cameraMount) {
      if (this.cameraMount.root.parent) this.cameraMount.root.parent.remove(this.cameraMount.root);
      this.cameraMount = null;
    }

    if (this.fieldMount) {
      if (this.fieldMount.root.parent) this.fieldMount.root.parent.remove(this.fieldMount.root);
      this.fieldMount = null;
    }

    this.lastParticles = {};
    this.lastAppliedMode = null;

    this.scene = null;
    this.camera = null;

    this.removeDebugMarker();
    if (this.debugMarker) {
      (this.debugMarker.geometry as THREE.BufferGeometry).dispose();
      (this.debugMarker.material as THREE.Material).dispose();
      this.debugMarker = null;
    }
    this.debugEnabled = false;

    this.removeDebugBounds();
    this.debugBoundsEnabled = false;
  }

  // ------------------------------------------------------------
  // Harmony snapshot handling (canonical truth)
  // ------------------------------------------------------------

  private onEnvironmentSnapshot(p: HarmonyEnvironmentSnapshot | undefined, kind: "state" | "changed"): void {
    const raw =
      (p?.particles as unknown) ??
      (p?.state?.particles as unknown) ??
      (p?.environment?.particles as unknown) ??
      {};

    // Cache last known particles (shallow, booleans only)
    const nextCache: Record<string, boolean> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        nextCache[k] = v === true;
      }
    }

    this.lastParticles = nextCache;

    const nextMode = pickFieldModeFromParticles(this.lastParticles);

    // ✅ IMPORTANT: "none selected" is TRUE OFF.
    // Always apply (including null) so effects don't "stick" after UI deselect.
    this.fieldFX.setMode(nextMode);
    this.lastAppliedMode = nextMode;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[ParticleFX] env snapshot (${kind}) -> FieldFX`,
        raw,
        "=>",
        nextMode ?? "(OFF)",
        "reason=",
        (p as any)?.reason,
      );
    }
  }

  /**
   * Intent debug only. We do NOT apply visual mode changes here.
   * This prevents intermediate states from flashing before the canonical snapshot arrives.
   */
  private onToggleIntentDebug(p: ToggleParticleIntent | undefined): void {
    if (!import.meta.env.DEV) return;

    const id = safeString(p?.particleId, "");
    if (!id) return;

    // eslint-disable-next-line no-console
    console.log(`[ParticleFX] toggle intent (ignored for apply) id='${id}' enabled=${Boolean(p?.enabled)}`);
  }

  // ------------------------------------------------------------
  // Local/world volume API (explicit) — kept for compatibility/future
  // ------------------------------------------------------------

  private onLocalRegister(p: LocalRegisterPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    const parent = (p as LocalRegisterPayload | undefined)?.parent;

    if (!anchorId || !parent) return;

    const existing = this.localMounts.get(anchorId);
    if (existing) {
      if (existing.root.parent) existing.root.parent.remove(existing.root);
      parent.add(existing.root);
      return;
    }

    const mount = this.createMount("local", anchorId);
    mount.root.name = `ParticleFXRoot_Local_${anchorId}`;
    parent.add(mount.root);

    this.localMounts.set(anchorId, mount);

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[ParticleFX] local register '${anchorId}' (note: local volumes not implemented yet in BAND-morph mode)`,
      );
    }
  }

  private onLocalUnregister(p: LocalUnregisterPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    if (!anchorId) return;

    const mount = this.localMounts.get(anchorId);
    if (!mount) return;

    if (mount.root.parent) mount.root.parent.remove(mount.root);
    this.localMounts.delete(anchorId);
  }

  private onLocalSet(p: LocalSetPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    const particleId = safeString(p?.particleId, "");
    if (!anchorId || !particleId) return;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[ParticleFX] local:set ignored (global BAND morph active) anchor='${anchorId}' particle='${particleId}' enabled=${Boolean(
          p?.enabled,
        )}`,
      );
    }
  }

  private onLocalApply(p: LocalApplyPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    if (!anchorId) return;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[ParticleFX] local:apply ignored (global BAND morph active) anchor='${anchorId}' particles=`,
        p?.particles,
      );
    }
  }

  private onLocalClear(p: LocalClearPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    if (!anchorId) return;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[ParticleFX] local:clear ignored (global BAND morph active) anchor='${anchorId}'`);
    }
  }

  // ------------------------------------------------------------
  // Mount lifecycle (debug roots only)
  // ------------------------------------------------------------

  private createMount(kind: MountKind, id: string): ParticleMount {
    return {
      kind,
      id,
      root: new THREE.Group(),
    };
  }

  private getActiveMount(): ParticleMount | null {
    return this.mode === "camera" ? this.cameraMount : this.fieldMount;
  }

  private detachMountFromScene(mount: ParticleMount | null): void {
    if (!mount) return;
    if (mount.root.parent) mount.root.parent.remove(mount.root);
  }

  private attachActiveMount(): void {
    if (!this.scene) return;

    this.detachMountFromScene(this.cameraMount);
    this.detachMountFromScene(this.fieldMount);

    const active = this.getActiveMount();
    if (!active) return;

    this.scene.add(active.root);

    if (active.kind === "field") {
      active.root.quaternion.identity();
    }
  }

  // ------------------------------------------------------------
  // Debug visuals (active mount)
  // ------------------------------------------------------------

  private refreshDebugAttachments(): void {
    if (!import.meta.env.DEV) return;

    const root = this.getActiveMount()?.root;

    if (!root) {
      this.removeDebugMarker();
      this.removeDebugBounds();
      return;
    }

    if (this.debugEnabled) this.ensureDebugMarker(root);
    else this.removeDebugMarker();

    if (this.debugBoundsEnabled) this.ensureDebugBounds(root);
    else this.removeDebugBounds();
  }

  private ensureDebugMarker(root: THREE.Object3D): void {
    if (this.debugMarker && this.debugMarker.parent === root) return;

    if (this.debugMarker && this.debugMarker.parent) {
      this.debugMarker.parent.remove(this.debugMarker);
    }

    if (!this.debugMarker) {
      const geo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00ff66,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "ParticleFXDebugMarker";
      mesh.renderOrder = 9999;
      this.debugMarker = mesh;
    }

    root.add(this.debugMarker);
  }

  private removeDebugMarker(): void {
    if (this.debugMarker && this.debugMarker.parent) {
      this.debugMarker.parent.remove(this.debugMarker);
    }
  }

  private ensureDebugBounds(root: THREE.Object3D): void {
    if (this.debugBounds && this.debugBounds.parent === root) return;

    if (this.debugBounds && this.debugBounds.parent) {
      this.debugBounds.parent.remove(this.debugBounds);
    }

    if (!this.debugBounds) {
      const radius = DEFAULT_DEBUG_RADIUS;
      const geo = new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 12, 10));
      const mat = new THREE.LineBasicMaterial({
        color: 0x00aaff,
        transparent: true,
        opacity: 0.65,
        depthTest: false,
        depthWrite: false,
      });

      const lines = new THREE.LineSegments(geo, mat);
      lines.name = "ParticleFXDebugBounds";
      lines.renderOrder = 9998;
      this.debugBounds = lines;
    }

    root.add(this.debugBounds);
  }

  private removeDebugBounds(): void {
    if (!this.debugBounds) return;

    if (this.debugBounds.parent) this.debugBounds.parent.remove(this.debugBounds);
    this.debugBounds.geometry.dispose();
    (this.debugBounds.material as THREE.Material).dispose();
    this.debugBounds = null;
  }

  // ------------------------------------------------------------
  // Bus helper
  // ------------------------------------------------------------

  private on<T = unknown>(event: string, handler: (payload: T) => void): void {
    const h = handler as unknown as AnyFn;
    this.bus.on(event, h);
    this.disposers.push(() => this.bus.off(event, h));
  }
}