// src/scenes/DemoScene.ts
// (Updated:
//  - CORE return now uses CameraDirector "flyTo" (no more fade+snap feel).
//  - Adds simple "current orbit target" guard so you cannot re-click the SAME target you're already orbiting.
//  - Adds targetId hints into camera:play params (Director can optionally use these now / later).
//  - Fixes a stray `{0` typo in buildConstellations signature.)
// NEW (Feb 2026):
//  - Forwards audio:frame -> postfx:audio-energy (impact01 = energy) so PostFX telemetry stops showing rx=0.
//  - DEV-only fallback: if no audio frames arrive for a while, emits a gentle sine pulse to prove wiring.

import * as THREE from "three";

import type { SceneController, SceneContext, SceneName } from "../apps/SceneTypes";

import { gsap } from "../core/Motion";

import type { CorePhase } from "../systems/CoreSystem";
import { CoreSystem } from "../systems/CoreSystem";
import { StarSystem } from "../systems/StarSystem";
import { RitualSystem } from "../systems/RitualSystem";
import { RegionSystem } from "../systems/RegionSystem";
import { ConstellationSystem } from "../systems/ConstellationSystem";

type RitualProgressPayload = {
  progress01?: number;
};

type InteractionClickPayload = {
  object: THREE.Object3D;
};

export class DemoScene implements SceneController {
  public readonly name: SceneName = "DemoScene";
  public readonly scene = new THREE.Scene();

  private gsapProofMesh: THREE.Mesh | null = null;

  private ctx: SceneContext | null = null;

  private clockFace: THREE.Object3D | null = null;

  private core: CoreSystem | null = null;
  private starSystem: StarSystem | null = null;
  private ritual: RitualSystem | null = null;

  private constellationSystem: ConstellationSystem | null = null;

  private ambientLight: THREE.AmbientLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;

  private elapsed = 0;

  private regionSystem: RegionSystem | null = null;
  private regionDebugRoot: THREE.Object3D | null = null;
  private regionDebugDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  // Cached list of what we told InteractionSystem to raycast
  private pickables: THREE.Object3D[] = [];

  // ---------------------------------------------------------------------------
  // Orbit target guard (prevents re-clicking the thing you're already orbiting)
  // ---------------------------------------------------------------------------

  private currentOrbitTargetId: string | null = null;

  private setCurrentOrbitTarget(id: string | null): void {
    this.currentOrbitTargetId = id;
  }

  private isCurrentOrbitTarget(id: string): boolean {
    return this.currentOrbitTargetId === id;
  }

  // ---------------------------------------------------------------------------
  // PostFX wiring helpers (Feb 2026)
  // ---------------------------------------------------------------------------

  private lastAudioFrameAtMs = -Infinity;

  // DEV-only: emit a gentle pulse when no real audio frames are arriving,
  // so PostFX telemetry proves rx/age immediately.
  private postfxDevPulseEnabled = import.meta.env.DEV;
  private postfxDevPulseT = 0;

  private onToggleRegions = (): void => {
    if (!this.regionDebugRoot) return;
    this.regionDebugRoot.visible = !this.regionDebugRoot.visible;

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[DemoScene] Region overlay ${this.regionDebugRoot.visible ? "ON" : "OFF"}`);
    }
  };

  private onDevCoreCycle = (): void => {
    if (!this.core) return;

    if (this.core.isBlackHoleOverrideEnabled()) {
      this.core.clearBlackHoleOverride();
      return;
    }

    this.core.toggleBlackHoleOverride();
  };

  private onDevCoreClear = (): void => {
    if (!this.core) return;
    this.core.clearBlackHoleOverride();
  };

  // ----------------------------------------------------------
  // Ritual -> Stars
  // ----------------------------------------------------------

  private onRitualProgress = (p: RitualProgressPayload): void => {
    if (!this.starSystem) return;
    const v = typeof p?.progress01 === "number" ? p.progress01 : 0;
    this.starSystem.setNearRevealTarget01(v);
  };

  private onRitualCancelled = (): void => {
    if (!this.starSystem) return;
    this.starSystem.setNearRevealTarget01(0.0);
  };

  private onRitualCompleted = (): void => {
    if (!this.starSystem) return;

    this.starSystem.setNearRevealTarget01(1.0);

    this.starSystem.triggerRadialPulse({
      speed: 1400,
      width: 1031,
      strength: 1.5,
    });
  };

  private onAudioFrame = (p: any): void => {
    const f = p?.frame;
    if (!f || !this.starSystem) return;

    this.lastAudioFrameAtMs = performance.now();

    this.starSystem.setAudioFrame({
      energy: f.energy,
      low: f.low,
      mid: f.mid,
      high: f.high,
    });

    this.starSystem.setAudioPlaying(Boolean(p?.isPlaying));

    // NEW: forward to PostFX
    // PostFX expects an "impact-style" 0..1 energy input. For now we map to energy directly.
    // (You can later swap this to a transient/peak metric without changing PostFX.)
    const impact01 = THREE.MathUtils.clamp(Number(f.energy ?? 0), 0, 1);

    this.ctx?.bus.emit("postfx:audio-energy", {
      impact01,
      low01: THREE.MathUtils.clamp(Number(f.low ?? 0), 0, 1),
      mid01: THREE.MathUtils.clamp(Number(f.mid ?? 0), 0, 1),
      high01: THREE.MathUtils.clamp(Number(f.high ?? 0), 0, 1),
    });
  };

  // ----------------------------------------------------------
  // InteractionSystem -> Core + Constellations
  // ----------------------------------------------------------

  private onInteractionClick = (p: InteractionClickPayload): void => {
    const obj = p?.object;
    if (!obj) return;

    // 1) Core click => return to orbiting the CORE
    if (this.core) {
      const coreRoot = this.core.getRoot();
      if (this.isDescendantOf(obj, coreRoot)) {
        // Guard: already orbiting CORE => ignore (reserved for future puzzle clicks on CORE)
        if (this.isCurrentOrbitTarget("CORE")) return;

        this.focusCore();
        return;
      }
    }

    // 2) Otherwise, hand off to Constellations (if present)
    if (this.constellationSystem) {
      this.constellationSystem.handlePickObject(obj);
    }
  };

  public init(ctx: SceneContext): void {
    this.ctx = ctx;

    // DEV: expose scene + ctx for console inspection
    if (import.meta.env.DEV) {
      (window as any).__scene = this.scene;
      (window as any).__ctx = ctx;
      (window as any).__demoScene = this;
    }

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[DemoScene] init");
    }

    this.scene.background = new THREE.Color(0x020208);

    this.buildClockFace();
    this.buildLights();
    this.buildCoreAndClock(ctx);
    this.buildStars();
    this.buildConstellations(ctx);
    this.buildGsapProofPulse();

    // Interaction wiring (no DOM listeners in scenes)
    this.rebuildPickables();
    ctx.bus.on("interaction:click", this.onInteractionClick);

    ctx.bus.on("audio:frame", this.onAudioFrame);

    if (this.core) {
      this.ritual = new RitualSystem(
        {
          bus: ctx.bus,
          domElement: ctx.renderer.domElement,
          camera: ctx.camera,
          coreRoot: this.core.getRoot(),
        },
        {
          holdDurationMs: 3000,
          enableKeyboardHold: true,
        },
      );

      ctx.bus.on("ritual:core:progress", this.onRitualProgress);
      ctx.bus.on("ritual:core:cancelled", this.onRitualCancelled);
      ctx.bus.on("ritual:core:completed", this.onRitualCompleted);
    }

    this.configureCamera(ctx);

    if (import.meta.env.DEV) {
      this.buildRegionWireframeOverlay();
      ctx.bus.on("dev:regions:toggle", this.onToggleRegions);
      ctx.bus.on("dev:core:cycle", this.onDevCoreCycle);
      ctx.bus.on("dev:core:clear", this.onDevCoreClear);
    }
  }

  private buildClockFace(): void {
    const root = new THREE.Object3D();
    root.name = "ClockFace";
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);

    this.scene.add(root);
    this.clockFace = root;
  }

  private buildLights(): void {
    this.ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    this.keyLight = new THREE.DirectionalLight(0xfff2d1, 1.0);
    this.keyLight.position.set(6, 8, 5);
    this.keyLight.castShadow = false;

    this.rimLight = new THREE.DirectionalLight(0x6fa9ff, 0.7);
    this.rimLight.position.set(-5, -3, -7);
    this.rimLight.castShadow = false;

    // Keeping existing behavior unchanged (not added).
    // If you want them active, uncomment:
    // this.scene.add(this.ambientLight);
    // this.scene.add(this.keyLight);
    // this.scene.add(this.rimLight);
  }

  private buildCoreAndClock(ctx: SceneContext): void {
    this.core = new CoreSystem({
      bus: ctx.bus,
      config: ctx.config,
      save: ctx.save,
      postFX: ctx.postFX,
    });

    const phase: CorePhase = "lunar";
    this.core.setPhase(phase);
    this.core.setShrinkLevel(0);

    if (!this.clockFace) {
      this.scene.add(this.core.getRoot());
      return;
    }

    this.clockFace.add(this.core.getRoot());
  }

  private buildStars(): void {
    this.starSystem = new StarSystem(this.scene, {
      exclusionRadius: 200,

      farCount: 31,
      farRadius: 8000,
      farSize: 3.1,

      nearCount: 500,
      nearInnerRadius: 5000,
      nearOuterRadius: 8000,
      nearSize: 1.2,

      nearReveal01: 0.0,
    });

    this.starSystem.setPulseMode("sphere");
  }

  private buildConstellations(ctx: SceneContext): void {
    if (!this.core) return;

    const coreRoot = this.core.getRoot();
    const coreColor = new THREE.Color(0xffb14a);

    // Orbit distance when focused on a constellation.
    const constellationOrbitDistance = 777;

    this.constellationSystem = new ConstellationSystem({
      scene: this.scene,
      camera: ctx.camera,
      coreObject: coreRoot,
      coreColor,

      ringRadius: 5000,
      orbRadius: 31,
      y: 0,

      angleOffsetRad: Math.PI * 0.5,

      onFocusRequest: (req) => {
        const pos = (req as any)?.position as THREE.Vector3 | undefined;
        if (!pos) return;

        // Best-effort stable ID (supports future puzzle clicks)
        const rawId =
          (req as any)?.id ??
          (req as any)?.orbId ??
          (req as any)?.name ??
          (req as any)?.key ??
          "unknown";
        const targetId = `CONSTELLATION:${String(rawId)}`;

        // Guard: already orbiting this constellation => ignore (reserved for puzzle clicks)
        if (this.isCurrentOrbitTarget(targetId)) return;

        this.setCurrentOrbitTarget(targetId);

        // Use the Director's "flyTo" for interaction navigation (feels natural).
        ctx.bus.emit("camera:play", {
          name: "flyTo",
          params: {
            targetId,
            target: { x: pos.x, y: pos.y, z: pos.z },
            distance: constellationOrbitDistance,
            duration: 1.1,
            ease: "power2.out",
            up: { x: 0, y: 0, z: 1 },
            lookLag: 0.22,
          },
          policy: "interrupt",
        });
      },
    });
  }

  private buildGsapProofPulse(): void {
    const geom = new THREE.SphereGeometry(14, 24, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffffff),
      transparent: true,
      opacity: 0.35,
      depthTest: true,
      depthWrite: false,
    });

    const m = new THREE.Mesh(geom, mat);
    m.name = "GSAP_ProofPulse";
    m.position.set(0, 120, 0);

    m.scale.setScalar(0.2);

    //this.scene.add(m);
    this.gsapProofMesh = m;

    gsap
      .timeline()
      .to(m.scale, { x: 1.15, y: 1.15, z: 1.15, duration: 0.28, ease: "power2.out" })
      .to(m.scale, { x: 0.85, y: 0.85, z: 0.85, duration: 0.22, ease: "power2.inOut" })
      .to(m.scale, { x: 1.0, y: 1.0, z: 1.0, duration: 0.3, ease: "power2.out" });
  }

  private configureCamera(ctx: SceneContext): void {
    const distance = 490;
    const theta = 0.0;
    const phi = 0.0001;

    const up = { x: 0, y: 0, z: 1 };

    const target = new THREE.Vector3(0, 0, 0);
    if (this.clockFace) this.clockFace.getWorldPosition(target);

    // Initial pose is CORE orbit.
    this.setCurrentOrbitTarget("CORE");

    ctx.bus.emit("camera:set-orbit", {
      target: { x: target.x, y: target.y, z: target.z },
      distance,
      theta,
      phi,
      up,
    });
  }

  // ----------------------------------------------------------
  // CORE focus helper
  // ----------------------------------------------------------

  private focusCore(): void {
    if (!this.ctx) return;

    const distance = 490;
    const up = { x: 0, y: 0, z: 1 };

    const target = new THREE.Vector3(0, 0, 0);
    if (this.clockFace) this.clockFace.getWorldPosition(target);

    // Mark current orbit target immediately (prevents double-click spam during flight).
    this.setCurrentOrbitTarget("CORE");

    // IMPORTANT:
    // Use "flyTo" for CORE return so you ALWAYS see the travel motion.
    // (ArcTo is fine for ceremonial return later, but right now it is getting "visually bypassed"
    // in your current flow when coming from constellation focus.)
    this.ctx.bus.emit("camera:play", {
      name: "flyTo",
      params: {
        targetId: "CORE",
        target: { x: target.x, y: target.y, z: target.z },
        distance,
        duration: 1.05,
        ease: "power2.out",
        up,
        lookLag: 0.22,
      },
      policy: "interrupt",
    });
  }

  // ----------------------------------------------------------
  // Pickables assembly
  // ----------------------------------------------------------

  private rebuildPickables(): void {
    if (!this.ctx) return;

    const objects: THREE.Object3D[] = [];

    // Constellation orbs
    if (this.constellationSystem) {
      const picks = this.constellationSystem.getPickableObjects();
      if (Array.isArray(picks)) objects.push(...picks);
    }

    // CORE: add ALL meshes under the core root so we don't depend on recursive raycast.
    if (this.core) {
      const coreRoot = this.core.getRoot();
      coreRoot.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) objects.push(o);
      });
    }

    this.pickables = objects;

    this.ctx.bus.emit("interaction:pickables:set", {
      objects: this.pickables,
    });
  }

  private isDescendantOf(obj: THREE.Object3D, root: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parent;
    }
    return false;
  }

  // (Region overlay code unchanged)
  private buildRegionWireframeOverlay(): void {
    this.regionSystem = new RegionSystem();

    if (this.clockFace) {
      this.regionSystem.setClockFace(this.clockFace);
    }

    const root = new THREE.Object3D();
    root.name = "RegionWireframeOverlay";
    root.visible = false;

    const y = 0.02;

    const universeRadius = new Date().getFullYear();
    const systemRadius = 10000;
    const spokeRadius = systemRadius;

    const regions = this.regionSystem.getRegions();
    const count = regions.length;
    const wedgeSize = (Math.PI * 2) / count;

    const baseRotationRad = this.regionSystem.getConfig().baseRotationRad;

    for (let i = 0; i < count; i++) {
      const angle = i * wedgeSize - baseRotationRad;

      const x = Math.cos(angle) * spokeRadius;
      const z = Math.sin(angle) * spokeRadius;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute([0, y, 0, x, y, z], 3));

      const hueDeg = regions[i].colorBias.hue;
      const c = new THREE.Color();
      c.setHSL((((hueDeg % 360) + 360) % 360) / 360, 0.9, 0.6);

      const mat = new THREE.LineBasicMaterial({
        color: c,
        transparent: true,
        opacity: 0.75,
        depthTest: true,
        depthWrite: false,
      });

      const line = new THREE.Line(geom, mat);
      line.name = `RegionBoundary_${regions[i].id}`;

      root.add(line);
      this.regionDebugDisposables.push(geom, mat);
    }

    const addRing = (radius: number, name: string, opacity: number): void => {
      const ringSegments = 192;
      const ringPts: number[] = [];

      for (let s = 0; s <= ringSegments; s++) {
        const t = s / ringSegments;
        const a = t * Math.PI * 2;
        ringPts.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      }

      const ringGeom = new THREE.BufferGeometry();
      ringGeom.setAttribute("position", new THREE.Float32BufferAttribute(ringPts, 3));

      const ringMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        transparent: true,
        opacity,
        depthTest: true,
        depthWrite: false,
      });

      const ring = new THREE.Line(ringGeom, ringMat);
      ring.name = name;

      root.add(ring);
      this.regionDebugDisposables.push(ringGeom, ringMat);
    };

    addRing(100, "DevRing_50", 0.14);
    addRing(200, "DevRing_100", 0.14);
    addRing(5000, "DevRing_250", 0.14);
    addRing(0, "DevRing_500", 0.14);

    addRing(systemRadius, `SystemRadius_${systemRadius}`, 0.25);
    addRing(universeRadius, `UniverseRadius_${universeRadius}`, 0.18);

    if (this.clockFace) this.clockFace.add(root);
    else this.scene.add(root);

    this.regionDebugRoot = root;

    // eslint-disable-next-line no-console
    console.log(`[DemoScene] Region overlay enabled. SystemRadius=${systemRadius}, UniverseRadius=${universeRadius}`);
  }

  public update(delta: number): void {
    this.elapsed += delta;

    const camera = this.ctx?.camera ?? null;

    if (this.core && camera) {
      const distance = camera.position.length();

      const minDist = 6;
      const maxDist = 40;

      const t = THREE.MathUtils.clamp((distance - minDist) / (maxDist - minDist), 0, 1);
      const distanceFactor = THREE.MathUtils.lerp(1.2, 0.35, t);
      this.core.setClockDistanceFactor(distanceFactor);
    }

    this.core?.update(delta);
    this.starSystem?.update(delta);
    //Zthis.constellationSystem?.update(delta);
    this.ritual?.update();

    // DEV-only: if no audio frames are coming in, emit a gentle pulse so PostFX telemetry proves wiring.
    if (import.meta.env.DEV && this.postfxDevPulseEnabled && this.ctx) {
      const now = performance.now();
      const ageMs = now - this.lastAudioFrameAtMs;

      // If we've seen no audio frames in the last ~250ms, we're likely idle.
      if (!Number.isFinite(ageMs) || ageMs > 250) {
        this.postfxDevPulseT += delta;

        // Slow smooth 0..1
        const impact01 = 0.5 + 0.5 * Math.sin(this.postfxDevPulseT * 2.0);

        this.ctx.bus.emit("postfx:audio-energy", { impact01 });
      }
    }
  }

  public dispose(): void {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[DemoScene] dispose");
    }

    if (this.regionDebugRoot) {
      if (this.clockFace) this.clockFace.remove(this.regionDebugRoot);
      else this.scene.remove(this.regionDebugRoot);
      this.regionDebugRoot = null;
    }
    for (const d of this.regionDebugDisposables) d.dispose();
    this.regionDebugDisposables = [];
    this.regionSystem = null;

    if (this.ctx) {
      this.ctx.bus.off("audio:frame", this.onAudioFrame);
      this.ctx.bus.off("ritual:core:progress", this.onRitualProgress);
      this.ctx.bus.off("ritual:core:cancelled", this.onRitualCancelled);
      this.ctx.bus.off("ritual:core:completed", this.onRitualCompleted);

      this.ctx.bus.off("interaction:click", this.onInteractionClick);

      // Clear pickables so InteractionSystem doesn't raycast stale objects after scene swap.
      this.ctx.bus.emit("interaction:pickables:set", { objects: [] });
    }

    this.pickables = [];
    this.currentOrbitTargetId = null;

    if (this.constellationSystem) {
      this.constellationSystem.dispose();
      this.constellationSystem = null;
    }

    if (this.starSystem) {
      this.starSystem.dispose(this.scene);
      this.starSystem = null;
    }

    if (this.ritual) {
      this.ritual.dispose();
      this.ritual = null;
    }

    if (this.core) {
      if (this.clockFace) this.clockFace.remove(this.core.getRoot());
      else this.scene.remove(this.core.getRoot());
      this.core.dispose();
      this.core = null;
    }

    if (this.clockFace) {
      this.scene.remove(this.clockFace);
      this.clockFace = null;
    }

    if (this.ambientLight) {
      this.scene.remove(this.ambientLight);
      this.ambientLight.dispose();
      this.ambientLight = null;
    }
    if (this.keyLight) {
      this.scene.remove(this.keyLight);
      this.keyLight.dispose();
      this.keyLight = null;
    }
    if (this.rimLight) {
      this.scene.remove(this.rimLight);
      this.rimLight.dispose();
      this.rimLight = null;
    }

    if (this.ctx && import.meta.env.DEV) {
      this.ctx.bus.off("dev:regions:toggle", this.onToggleRegions);
      this.ctx.bus.off("dev:core:cycle", this.onDevCoreCycle);
      this.ctx.bus.off("dev:core:clear", this.onDevCoreClear);
    }

    if (this.gsapProofMesh) {
      this.scene.remove(this.gsapProofMesh);
      this.gsapProofMesh.geometry.dispose();
      (this.gsapProofMesh.material as THREE.Material).dispose();
      this.gsapProofMesh = null;
    }

    this.ctx = null;
  }
}
