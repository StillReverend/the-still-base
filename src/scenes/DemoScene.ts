// src/scenes/DemoScene.ts
// (Only changes are in the ritual handlers + initial star setup logic.)

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

  private lastUiHoverAt = 0;
  private readonly uiHoverCooldownMs = 140;

  // ----------------------------------------------------------
  // Ritual -> Stars
  // ----------------------------------------------------------

  private onRitualProgress = (p: RitualProgressPayload): void => {
    if (!this.starSystem) return;
    const v = typeof p?.progress01 === "number" ? p.progress01 : 0;
    // Drive the “external lane” continuously during the hold.
    this.starSystem.setNearRevealTarget01(v);
  };

  private onRitualCancelled = (): void => {
    if (!this.starSystem) return;
    // Cancel means: let near go dark again (unless audio is playing).
    this.starSystem.setNearRevealTarget01(0.0);
  };

  private onRitualCompleted = (): void => {
    if (!this.starSystem) return;

    // Momentary full bright (external lane), then it will decay automatically
    // unless audio is playing and driving the breathing.
    this.starSystem.setNearRevealTarget01(1.0);

    this.starSystem.triggerRadialPulse({
      speed: 1400,
      width: 1031,
      strength: 1.50,
    });
  };

  private onAudioFrame = (p: any): void => {
    const f = p?.frame;
    if (!f || !this.starSystem) return;

    this.starSystem.setAudioFrame({
      energy: f.energy,
      low: f.low,
      mid: f.mid,
      high: f.high,
    });

    // This is the key switch: no audio playing => near stars fully dark (unless ritual drives them)
    this.starSystem.setAudioPlaying(Boolean(p?.isPlaying));
  };

  // ----------------------------------------------------------
  // Pointer -> Constellations
  // ----------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.ctx || !this.constellationSystem) return;

    // NDC coords (-1..+1)
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

    const hit = this.constellationSystem.handlePointerDown(x, y);
    if (hit) {
      this.ctx.bus.emit("ui:click", { kind: "click" });
    }

  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.ctx || !this.constellationSystem) return;

    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

    const entered = this.constellationSystem.handlePointerMove(x, y);
    if (!entered) return;

    const now = performance.now();
    if (now - this.lastUiHoverAt < this.uiHoverCooldownMs) return;
    this.lastUiHoverAt = now;

    this.ctx.bus.emit("ui:hover", { kind: "hover" });
  };

  public init(ctx: SceneContext): void {
    this.ctx = ctx;

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

    // Scene-local click handling (focusable objects)
    ctx.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    ctx.renderer.domElement.addEventListener("pointermove", this.onPointerMove);

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
      farSize: 1.5,

      nearCount: 500,
      nearInnerRadius: 5000,
      nearOuterRadius: 8000,
      nearSize: 1.2,

      // IMPORTANT: start at 0 so no NEAR stars show until audio or ritual
      nearReveal01: 0.0,
    });

    // Default to cosmic sphere shockwave (you preferred “all directions”)
    this.starSystem.setPulseMode("sphere");
  }

  private buildConstellations(ctx: SceneContext): void {
    if (!this.core) return;

    const coreRoot = this.core.getRoot();

    // Scaffold: warm core identity color. Later this can be pulled from CoreSystem phase/state.
    const coreColor = new THREE.Color(0xffb14a);

    // Orbit distance when focused on a constellation.
    // Goal: allow seeing Core in the distance sometimes.
    const constellationOrbitDistance = 220;

    this.constellationSystem = new ConstellationSystem({
      scene: this.scene,
      camera: ctx.camera,
      coreObject: coreRoot,
      coreColor,

      // Placement ring (clock positions)
      ringRadius: 5000,
      orbRadius: 100,
      y: 0,

      // Align index 0 to "12 o'clock" (tune depending on your world forward)
      angleOffsetRad: Math.PI * 0.5,

      // Click-to-focus: clicked orb becomes new orbit target (fly-to comes later).
      onFocusRequest: (req) => {
        const pos = req.position;

        ctx.bus.emit("camera:set-orbit", {
          target: { x: pos.x, y: pos.y, z: pos.z },
          distance: constellationOrbitDistance,
          theta: 0.0,
          phi: 0.0001,
          up: { x: 0, y: 0, z: 1 },
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

    // Start small so the pulse is obvious.
    m.scale.setScalar(0.2);

    this.scene.add(m);
    this.gsapProofMesh = m;

    // One-shot pulse: pop in, breathe, settle.
    gsap
      .timeline()
      .to(m.scale, { x: 1.15, y: 1.15, z: 1.15, duration: 0.28, ease: "power2.out" })
      .to(m.scale, { x: 0.85, y: 0.85, z: 0.85, duration: 0.22, ease: "power2.inOut" })
      .to(m.scale, { x: 1.0, y: 1.0, z: 1.0, duration: 0.30, ease: "power2.out" });
  }

  private configureCamera(ctx: SceneContext): void {
    const distance = 490;
    const theta = 0.0;
    const phi = 0.0001;

    const up = { x: 0, y: 0, z: 1 };

    const target = new THREE.Vector3(0, 0, 0);
    if (this.clockFace) this.clockFace.getWorldPosition(target);

    ctx.bus.emit("camera:set-orbit", {
      target: { x: target.x, y: target.y, z: target.z },
      distance,
      theta,
      phi,
      up,
    });
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
    this.constellationSystem?.update(delta);
    this.ritual?.update();
  }

  public dispose(): void {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[DemoScene] dispose");
    }

    if (this.ctx) {
      this.ctx.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
      this.ctx.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
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
    }

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
