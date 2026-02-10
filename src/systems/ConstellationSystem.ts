// src/systems/ConstellationSystem.ts
// ============================================================
// THE STILL — ConstellationSystem (Scaffold)
// ------------------------------------------------------------
// Responsibilities (Scaffold MVP):
//  - Spawn 12 Constellation Orbs in a clock ring around the Core.
//  - Render a bi-tapered filament Core <-> Orb with Core->Orb color gradient.
//  - Provide picking (raycast) for orbs.
//  - Request camera focus on click (integration via callback).
//  - Expose pickables + object-based pick handling for InteractionSystem.
// ============================================================

import * as THREE from "three";

export type ConstellationId = number;

export type ConstellationFocusRequest = {
  id: ConstellationId;
  object: THREE.Object3D;
  position: THREE.Vector3;
};

type ConstellationOrb = {
  id: ConstellationId;
  color: THREE.Color;
  mesh: THREE.Mesh;
  filament: FilamentRibbon;
};

export type ConstellationSystemParams = {
  scene: THREE.Scene;
  camera: THREE.Camera;

  // World refs
  coreObject: THREE.Object3D; // the core sphere (or a parent anchor)
  coreColor: THREE.Color;

  // Layout
  ringRadius: number; // distance from core to orbs
  orbRadius: number; // orb sphere radius
  y: number; // ring plane height (0 = centered)

  // Clock alignment (so “12 o’clock” faces where you want)
  angleOffsetRad?: number;

  // Callbacks
  onFocusRequest?: (req: ConstellationFocusRequest) => void;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * A camera-facing ribbon that connects A->B with:
 *  - Hourglass width (thick at both ends, thin mid)
 *  - Core->Orb color gradient along length
 *  - Soft edges + additive blending
 *
 * Geometry: segmented strip (2 verts per segment row).
 */
class FilamentRibbon {
  public readonly mesh: THREE.Mesh;

  private readonly segments: number;
  private readonly positions: Float32Array;
  private readonly sides: Float32Array; // -1..+1 for edge feather
  private readonly ts: Float32Array; // 0..1 along length

  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  private _start = new THREE.Vector3();
  private _end = new THREE.Vector3();

  // scratch (avoid per-frame allocations)
  private readonly dir = new THREE.Vector3();
  private readonly camForward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly P = new THREE.Vector3();

  constructor(params: {
    segments?: number;
    thickEnd: number;
    thinMid: number;
    coreColor: THREE.Color;
    orbColor: THREE.Color;
    intensity?: number;
  }) {
    this.segments = params.segments ?? 32;

    const rows = this.segments + 1;
    const vertCount = rows * 2;

    this.positions = new Float32Array(vertCount * 3);
    this.sides = new Float32Array(vertCount);
    this.ts = new Float32Array(vertCount);

    const indexCount = this.segments * 6;
    const indices = new Uint32Array(indexCount);

    let v = 0;
    for (let i = 0; i < rows; i++) {
      this.sides[v] = -1;
      this.ts[v] = i / this.segments;
      v++;

      this.sides[v] = +1;
      this.ts[v] = i / this.segments;
      v++;
    }

    let idx = 0;
    for (let i = 0; i < this.segments; i++) {
      const a = i * 2 + 0;
      const b = i * 2 + 1;
      const c = i * 2 + 2;
      const d = i * 2 + 3;

      indices[idx++] = a;
      indices[idx++] = c;
      indices[idx++] = b;

      indices[idx++] = b;
      indices[idx++] = c;
      indices[idx++] = d;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute("aSide", new THREE.BufferAttribute(this.sides, 1));
    this.geo.setAttribute("aT", new THREE.BufferAttribute(this.ts, 1));

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCoreColor: { value: params.coreColor.clone() },
        uOrbColor: { value: params.orbColor.clone() },
        uIntensity: { value: params.intensity ?? 1.0 },
        uTime: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSide; // -1..+1
        attribute float aT;    // 0..1

        varying float vSide;
        varying float vT;

        void main() {
          vSide = aSide;
          vT = aT;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCoreColor;
        uniform vec3 uOrbColor;
        uniform float uIntensity;
        uniform float uTime;

        varying float vSide;
        varying float vT;

        void main() {
          vec3 col = mix(uCoreColor, uOrbColor, vT);

          float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));
          float center = 1.0 - abs(2.0 * vT - 1.0);
          float glow = 0.65 + 0.35 * pow(center, 0.8);

          float alpha = edge * glow * uIntensity;

          float shimmer = 0.92 + 0.08 * sin(uTime * 1.7 + vT * 12.0);
          vec3 outCol = col * shimmer;

          gl_FragColor = vec4(outCol, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  setColors(coreColor: THREE.Color, orbColor: THREE.Color): void {
    this.mat.uniforms.uCoreColor.value.copy(coreColor);
    this.mat.uniforms.uOrbColor.value.copy(orbColor);
  }

  setEndpoints(start: THREE.Vector3, end: THREE.Vector3): void {
    this._start.copy(start);
    this._end.copy(end);
  }

  update(dt: number, camera: THREE.Camera, thickEnd: number, thinMid: number): void {
    this.mat.uniforms.uTime.value += dt;

    const A = this._start;
    const B = this._end;

    this.dir.subVectors(B, A);
    const len = this.dir.length();
    if (len < 0.0001) return;
    this.dir.multiplyScalar(1 / len);

    camera.getWorldDirection(this.camForward);

    this.right.crossVectors(this.dir, this.camForward);
    const rLen = this.right.length();
    if (rLen < 0.0001) this.right.set(1, 0, 0);
    else this.right.multiplyScalar(1 / rLen);

    const shapeK = 2.2;
    const rows = this.segments + 1;

    let p = 0;
    for (let i = 0; i < rows; i++) {
      const t = i / this.segments;

      const endWeight = Math.abs(2 * t - 1);
      const shaped = Math.pow(endWeight, shapeK);
      const w = thinMid + (thickEnd - thinMid) * shaped;

      this.P.lerpVectors(A, B, t);

      // left
      this.positions[p++] = this.P.x - this.right.x * w;
      this.positions[p++] = this.P.y - this.right.y * w;
      this.positions[p++] = this.P.z - this.right.z * w;

      // right
      this.positions[p++] = this.P.x + this.right.x * w;
      this.positions[p++] = this.P.y + this.right.y * w;
      this.positions[p++] = this.P.z + this.right.z * w;
    }

    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class ConstellationSystem {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly coreObject: THREE.Object3D;
  private readonly coreColor: THREE.Color;

  private readonly ringRadius: number;
  private readonly orbRadius: number;
  private readonly y: number;
  private readonly angleOffsetRad: number;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private readonly orbs: ConstellationOrb[] = [];

  private onFocusRequest?: (req: ConstellationFocusRequest) => void;

  private hoveredId: number | null = null;

  // scratch
  private readonly vA = new THREE.Vector3();
  private readonly vB = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly pickWorldPos = new THREE.Vector3();

  constructor(params: ConstellationSystemParams) {
    this.scene = params.scene;
    this.camera = params.camera;
    this.coreObject = params.coreObject;
    this.coreColor = params.coreColor.clone();

    this.ringRadius = params.ringRadius;
    this.orbRadius = params.orbRadius;
    this.y = params.y;
    this.angleOffsetRad = params.angleOffsetRad ?? 0;

    this.onFocusRequest = params.onFocusRequest;

    this.buildOrbs();
  }

  getPickableObjects(): THREE.Object3D[] {
    return this.orbs.map((o) => o.mesh);
  }

  handlePickObject(object: THREE.Object3D): boolean {
    const id = object?.userData?.constellationId;
    if (typeof id !== "number") return false;

    const orb = this.orbs.find((o) => o.id === id);
    if (!orb) return false;

    const pos = orb.mesh.getWorldPosition(this.pickWorldPos);

    this.onFocusRequest?.({
      id,
      object: orb.mesh,
      position: pos.clone(),
    });

    return true;
  }

  private buildOrbs(): void {
    const palette = [
      0x40c9ff, 0x7a5cff, 0xff4fd8, 0xff5a3c, 0xffb74a, 0x9bff57, 0x2dffcc, 0x2aa9ff, 0x7ef0ff,
      0xa779ff, 0xff79b0, 0xffd36e,
    ].map((hex) => new THREE.Color(hex));

    for (let i = 0; i < 12; i++) {
      const color = palette[i % palette.length].clone();

      const geo = new THREE.SphereGeometry(this.orbRadius, 32, 24);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.79,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `ConstellationOrb_${i}`;
      mesh.userData.constellationId = i;

      const t = i / 12;
      const a = t * Math.PI * 2 + this.angleOffsetRad;

      mesh.position.set(Math.cos(a) * this.ringRadius, this.y, Math.sin(a) * this.ringRadius);

      this.scene.add(mesh);

      const filament = new FilamentRibbon({
        segments: 36,
        thickEnd: this.orbRadius * 0.55,
        thinMid: this.orbRadius * 0.12,
        coreColor: this.coreColor,
        orbColor: color,
        intensity: 1.0,
      });

      this.scene.add(filament.mesh);

      this.orbs.push({ id: i, color, mesh, filament });
    }
  }

  /** Legacy: Call this from your pointer handler (normalized device coords). Returns true if hit. */
  handlePointerDown(ndcX: number, ndcY: number): boolean {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(
      this.orbs.map((o) => o.mesh),
      false,
    );

    if (!hits.length) return false;

    const hit = hits[0].object as THREE.Object3D;
    return this.handlePickObject(hit);
  }

  /**
   * Legacy: Pointer hover support. Returns true only when hover ENTERS a valid orb
   * (i.e., hover changes from null/other -> some orb).
   */
  handlePointerMove(ndcX: number, ndcY: number): boolean {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(
      this.orbs.map((o) => o.mesh),
      false,
    );

    if (!hits.length) {
      this.hoveredId = null;
      return false;
    }

    const hit = hits[0].object as THREE.Object3D;
    const id = hit.userData.constellationId as number;

    if (this.hoveredId === id) return false;

    this.hoveredId = id;
    return true;
  }

  update(dt: number): void {
    const corePos = this.coreObject.getWorldPosition(this.vA);

    for (const orb of this.orbs) {
      const orbPos = orb.mesh.getWorldPosition(this.vB);

      this.dir.subVectors(orbPos, corePos).normalize();

      const start = this.start.copy(corePos).addScaledVector(this.dir, 1.0);
      const end = this.end.copy(orbPos).addScaledVector(this.dir, -this.orbRadius * 0.9);

      orb.filament.setColors(this.coreColor, orb.color);
      orb.filament.setEndpoints(start, end);

      // If you want the filament visible, enable this line (left off to preserve current behavior)
      // orb.filament.update(dt, this.camera, this.orbRadius * 0.55, this.orbRadius * 0.12);
    }
  }

  dispose(): void {
    for (const orb of this.orbs) {
      (orb.mesh.geometry as THREE.BufferGeometry).dispose();
      (orb.mesh.material as THREE.Material).dispose();
      orb.filament.dispose();
      this.scene.remove(orb.mesh);
      this.scene.remove(orb.filament.mesh);
    }
    this.orbs.length = 0;
  }
}
