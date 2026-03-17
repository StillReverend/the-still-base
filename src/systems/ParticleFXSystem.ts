// src/systems/ParticleFXSystem.ts
// ============================================================
// THE STILL — ParticleFXSystem (owned particle field + mode router)
// ------------------------------------------------------------
// New direction:
//  - ParticleFXSystem now owns its own dynamic particle field
//  - FieldFXSystem no longer depends on StarSystem BAND ownership
//  - Harmony particle selections are still routed canonically from snapshots
//  - Existing debug mounts/local API remain intact for future work
//
// Notes:
//  - We keep a THREE.PointsMaterial substrate for compatibility with the
//    current emitter stack (Rain/Snow/Fireflies shader patching, etc).
//  - The field is created as a spherical shell so current emitters inherit
//    a familiar spatial distribution.
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
const safeString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

// Preferred priority when multiple toggles are true.
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
//  - null when nothing is selected (TRUE OFF state)
function pickFieldModeFromParticles(raw: unknown): FieldFXMode | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;

  for (const k of FIELD_MODE_PRIORITY) {
    if (m[k] === true) return k;
  }

  if (m.stars === true) return "stars";
  return null;
}

// ------------------------------------------------------------
// Particle field substrate config
// ------------------------------------------------------------

type ParticleFieldConfig = {
  count: number;
  innerRadius: number;
  outerRadius: number;
  pointSize: number;
  color: number;
  opacity: number;
  blending: THREE.Blending;
  sizeAttenuation: boolean;
  visibleByDefault: boolean;
};

const PARTICLE_FIELD_NAME = "ParticleFX_FIELD";

const DEFAULT_PARTICLE_FIELD: ParticleFieldConfig = {
  count: 4096,
  innerRadius: 1300,
  outerRadius: 2600,
  pointSize: 0.5,
  color: 0xffffed,
  opacity: 1.0,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: false,
  visibleByDefault: false,
};

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

  // FIELD is the debug mount default.
  private mode: ParticleMode = "field";

  // ------------------------------------------------------------
  // Owned particle field substrate
  // ------------------------------------------------------------

  private particleFieldRoot: THREE.Group | null = null;
  private particleFieldPoints: THREE.Points | null = null;
  private particleFieldGeometry: THREE.BufferGeometry | null = null;
  private particleFieldMaterial: THREE.PointsMaterial | null = null;

  // ------------------------------------------------------------
  // FieldFX
  // ------------------------------------------------------------

  private readonly fieldFX: FieldFXSystem;

  private lastParticles: Record<string, boolean> = {};
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
    this.fieldFX = new FieldFXSystem({ bus: this.bus });
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.on<HarmonyEnvironmentSnapshot>("harmony:environment:state", (p) =>
      this.onEnvironmentSnapshot(p, "state"),
    );
    this.on<HarmonyEnvironmentSnapshot>("harmony:environment:changed", (p) =>
      this.onEnvironmentSnapshot(p, "changed"),
    );

    this.on<ToggleParticleIntent>("harmony:environment:toggleParticle", (p) =>
      this.onToggleIntentDebug(p),
    );
    this.on<ToggleParticleIntent>("harmony:env:toggleParticle", (p) =>
      this.onToggleIntentDebug(p),
    );

    this.on<{ enabled: boolean }>("particlefx:debug:set", (p) =>
      this.setDebug(Boolean(p?.enabled)),
    );
    this.on<{ enabled: boolean }>("particlefx:debug-bounds:set", (p) =>
      this.setDebugBounds(Boolean(p?.enabled)),
    );

    this.on<{ mode: ParticleMode }>("particlefx:mode:set", (p) => {
      const next: ParticleMode = p?.mode === "camera" ? "camera" : "field";
      this.setMode(next);
    });

    this.on<LocalRegisterPayload>("particlefx:local:register", (p) =>
      this.onLocalRegister(p),
    );
    this.on<LocalUnregisterPayload>("particlefx:local:unregister", (p) =>
      this.onLocalUnregister(p),
    );
    this.on<LocalSetPayload>("particlefx:local:set", (p) =>
      this.onLocalSet(p),
    );
    this.on<LocalApplyPayload>("particlefx:local:apply", (p) =>
      this.onLocalApply(p),
    );
    this.on<LocalClearPayload>("particlefx:local:clear", (p) =>
      this.onLocalClear(p),
    );
  }

  public setTargets(scene: THREE.Scene | null, camera: THREE.Camera | null): void {
    if (this.scene === scene && this.camera === camera) return;

    this.detachMountFromScene(this.cameraMount);
    this.detachMountFromScene(this.fieldMount);
    this.detachParticleFieldFromScene();

    this.scene = scene;
    this.camera = camera;

    if (!this.scene || !this.camera) {
      this.removeDebugMarker();
      this.removeDebugBounds();
      return;
    }

    this.ensureParticleField();
    if (this.particleFieldPoints) {
      this.fieldFX.attachParticlePoints(this.particleFieldPoints);
    }
    this.fieldFX.setTargets(this.scene, this.camera);

    if (!this.cameraMount) {
      this.cameraMount = this.createMount("camera", CAMERA_MOUNT_ID);
      this.cameraMount.root.name = "ParticleFXRoot_Camera";
    }

    if (!this.fieldMount) {
      this.fieldMount = this.createMount("field", FIELD_MOUNT_ID);
      this.fieldMount.root.name = "ParticleFXRoot_Field";
    }

    const camAny = this.camera as unknown as { near?: number };
    const near =
      typeof camAny.near === "number" && isFiniteNumber(camAny.near)
        ? camAny.near
        : 0.1;
    this.cameraForwardOffset = Math.max(MIN_CAMERA_OFFSET, near * 6);

    this.attachActiveMount();
    this.refreshDebugAttachments();
  }

  public update(dt: number): void {
    this.fieldFX.update(dt);

    const active = this.getActiveMount();
    if (active && this.camera) {
      if (active.kind === "camera") {
        this.camera.getWorldPosition(this.tmpPos);
        this.camera.getWorldQuaternion(this.tmpQuat);
        this.camera.getWorldDirection(this.tmpDir);

        active.root.position
          .copy(this.tmpPos)
          .add(this.tmpDir.multiplyScalar(this.cameraForwardOffset));
        active.root.quaternion.copy(this.tmpQuat);
      } else if (active.kind === "field") {
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

    this.fieldFX.dispose();

    for (const m of this.localMounts.values()) {
      if (m.root.parent) m.root.parent.remove(m.root);
    }
    this.localMounts.clear();

    if (this.cameraMount) {
      if (this.cameraMount.root.parent) {
        this.cameraMount.root.parent.remove(this.cameraMount.root);
      }
      this.cameraMount = null;
    }

    if (this.fieldMount) {
      if (this.fieldMount.root.parent) {
        this.fieldMount.root.parent.remove(this.fieldMount.root);
      }
      this.fieldMount = null;
    }

    this.destroyParticleField();

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

  private onEnvironmentSnapshot(
    p: HarmonyEnvironmentSnapshot | undefined,
    kind: "state" | "changed",
  ): void {
    const raw =
      (p?.particles as unknown) ??
      (p?.state?.particles as unknown) ??
      (p?.environment?.particles as unknown) ??
      {};

    const nextCache: Record<string, boolean> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        nextCache[k] = v === true;
      }
    }

    this.lastParticles = nextCache;

    const nextMode = pickFieldModeFromParticles(this.lastParticles);

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

  private onToggleIntentDebug(p: ToggleParticleIntent | undefined): void {
    if (!import.meta.env.DEV) return;

    const id = safeString(p?.particleId, "");
    if (!id) return;

    // eslint-disable-next-line no-console
    console.log(
      `[ParticleFX] toggle intent (ignored for apply) id='${id}' enabled=${Boolean(
        p?.enabled,
      )}`,
    );
  }

  // ------------------------------------------------------------
  // Local/world volume API (compat/future)
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
        `[ParticleFX] local register '${anchorId}' (global particle field active)`,
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
        `[ParticleFX] local:set ignored (single shared particle field active) anchor='${anchorId}' particle='${particleId}' enabled=${Boolean(
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
        `[ParticleFX] local:apply ignored (single shared particle field active) anchor='${anchorId}' particles=`,
        p?.particles,
      );
    }
  }

  private onLocalClear(p: LocalClearPayload | undefined): void {
    const anchorId = safeString(p?.anchorId, "");
    if (!anchorId) return;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `[ParticleFX] local:clear ignored (single shared particle field active) anchor='${anchorId}'`,
      );
    }
  }

  // ------------------------------------------------------------
  // Owned particle field
  // ------------------------------------------------------------

  private ensureParticleField(): void {
    if (!this.scene) return;
    if (this.particleFieldPoints && this.particleFieldRoot) {
      if (!this.particleFieldRoot.parent) this.scene.add(this.particleFieldRoot);
      return;
    }

    const cfg = DEFAULT_PARTICLE_FIELD;

    const geometry = new THREE.BufferGeometry();
    const positions = this.makeShellPositions(
      cfg.count,
      cfg.innerRadius,
      cfg.outerRadius,
    );
    const colors = new Float32Array(cfg.count * 3);

    for (let i = 0; i < cfg.count; i++) {
      const k = i * 3;
      colors[k + 0] = 0;
      colors[k + 1] = 0;
      colors[k + 2] = 0;
    }

    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);

    const colorAttr = new THREE.BufferAttribute(colors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttr);

    const material = new THREE.PointsMaterial({
      color: cfg.color,
      vertexColors: true,
      size: cfg.pointSize,
      sizeAttenuation: cfg.sizeAttenuation,
      transparent: true,
      opacity: cfg.opacity,
      depthWrite: false,
      blending: cfg.blending,
    });

    const points = new THREE.Points(geometry, material);
    points.name = PARTICLE_FIELD_NAME;
    points.frustumCulled = false;
    points.visible = cfg.visibleByDefault;
    points.renderOrder = 10;

    const root = new THREE.Group();
    root.name = "ParticleFXFieldRoot";
    root.add(points);

    this.scene.add(root);

    this.particleFieldRoot = root;
    this.particleFieldPoints = points;
    this.particleFieldGeometry = geometry;
    this.particleFieldMaterial = material;
  }

  private destroyParticleField(): void {
    this.detachParticleFieldFromScene();

    if (this.particleFieldGeometry) {
      this.particleFieldGeometry.dispose();
      this.particleFieldGeometry = null;
    }

    if (this.particleFieldMaterial) {
      this.particleFieldMaterial.dispose();
      this.particleFieldMaterial = null;
    }

    this.particleFieldPoints = null;
    this.particleFieldRoot = null;
  }

  private detachParticleFieldFromScene(): void {
    if (this.particleFieldRoot && this.particleFieldRoot.parent) {
      this.particleFieldRoot.parent.remove(this.particleFieldRoot);
    }
  }

  private makeShellPositions(
    count: number,
    innerRadius: number,
    outerRadius: number,
  ): Float32Array {
    const safeCount = Math.max(1, count | 0);
    const inner = Math.max(0, innerRadius);
    const outer = Math.max(inner + 1, outerRadius);

    const out = new Float32Array(safeCount * 3);

    const r0c = inner * inner * inner;
    const r1c = outer * outer * outer;

    for (let i = 0; i < safeCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const phi = Math.acos(u);

      const tt = Math.random();
      const r = Math.cbrt(r0c + tt * (r1c - r0c));

      out[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      out[i * 3 + 1] = r * Math.cos(phi);
      out[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }

    return out;
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
      const geo = new THREE.WireframeGeometry(
        new THREE.SphereGeometry(radius, 12, 10),
      );
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