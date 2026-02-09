// ============================================================
// THE STILL — ConstellationSystem (Scaffold)
// ------------------------------------------------------------
// Responsibilities (Scaffold MVP):
//  - Spawn 12 Constellation Orbs in a clock ring around the Core.
//  - Render a bi-tapered filament Core <-> Orb with Core->Orb color gradient.
//  - Provide picking (raycast) for orbs.
//  - Request camera focus/fly-to on click (integration via callback).
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
  ringRadius: number;   // distance from core to orbs
  orbRadius: number;    // orb sphere radius
  y: number;            // ring plane height (0 = centered)

  // Clock alignment (so “12 o’clock” faces where you want)
  angleOffsetRad?: number;

  // Callbacks
  onFocusRequest?: (req: ConstellationFocusRequest) => void;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(edge0: number, edge1: number, x: number) {
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
  private readonly ts: Float32Array;    // 0..1 along length

  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  private _start = new THREE.Vector3();
  private _end = new THREE.Vector3();

  constructor(params: {
    segments?: number;
    thickEnd: number;
    thinMid: number;
    coreColor: THREE.Color;
    orbColor: THREE.Color;
    intensity?: number;
  }) {
    this.segments = params.segments ?? 32;

    // Vertex layout: for each segment step i (0..segments),
    // we create two vertices: left/right side of ribbon.
    const rows = this.segments + 1;
    const vertCount = rows * 2;

    this.positions = new Float32Array(vertCount * 3);
    this.sides = new Float32Array(vertCount);
    this.ts = new Float32Array(vertCount);

    // Indices for triangle strip
    const indexCount = this.segments * 6;
    const indices = new Uint32Array(indexCount);

    let v = 0;
    for (let i = 0; i < rows; i++) {
      // left vertex
      this.sides[v] = -1;
      this.ts[v] = i / this.segments;
      v++;

      // right vertex
      this.sides[v] = +1;
      this.ts[v] = i / this.segments;
      v++;
    }

    // triangles
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
        uThickEnd: { value: params.thickEnd },
        uThinMid: { value: params.thinMid },
        uShapeK: { value: 2.2 }, // higher = “fatter ends”
        uIntensity: { value: params.intensity ?? 1.0 },
        uTime: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        uniform float uThickEnd;
        uniform float uThinMid;
        uniform float uShapeK;
        uniform float uTime;

        attribute float aSide; // -1..+1
        attribute float aT;    // 0..1

        varying float vSide;
        varying float vT;

        // Hourglass width: thick at both ends, thin in middle
        float widthProfile(float t) {
          float endWeight = abs(2.0 * t - 1.0); // 1 at ends, 0 mid
          float shaped = pow(endWeight, uShapeK);
          return mix(uThinMid, uThickEnd, shaped);
        }

        void main() {
          vSide = aSide;
          vT = aT;

          // Positions are written CPU-side each frame (already billboarded).
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
          // Color gradient along length
          vec3 col = mix(uCoreColor, uOrbColor, vT);

          // Soft edge feather across width
          float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));

          // Slight along-length shaping (keeps center a little “charged”)
          float center = 1.0 - abs(2.0 * vT - 1.0); // 0 ends, 1 mid
          float glow = 0.65 + 0.35 * pow(center, 0.8);

          float alpha = edge * glow * uIntensity;

          // Tiny shimmer (very subtle)
          float shimmer = 0.92 + 0.08 * sin(uTime * 1.7 + vT * 12.0);
          vec3 outCol = col * shimmer;

          gl_FragColor = vec4(outCol, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  setColors(coreColor: THREE.Color, orbColor: THREE.Color) {
    this.mat.uniforms.uCoreColor.value.copy(coreColor);
    this.mat.uniforms.uOrbColor.value.copy(orbColor);
  }

  setEndpoints(start: THREE.Vector3, end: THREE.Vector3) {
    this._start.copy(start);
    this._end.copy(end);
  }

  update(dt: number, camera: THREE.Camera) {
    this.mat.uniforms.uTime.value += dt;

    // Build billboarded ribbon CPU-side so we can control width profile precisely.
    // We compute a “right” vector perpendicular to (A->B) and camera forward.
    const A = this._start;
    const B = this._end;

    const dir = new THREE.Vector3().subVectors(B, A);
    const len = dir.length();
    if (len < 0.0001) return;
    dir.multiplyScalar(1 / len);

    // camera forward (world)
    const camForward = new THREE.Vector3();
    camera.getWorldDirection(camForward);

    // right = normalize(dir x camForward)
    const right = new THREE.Vector3().crossVectors(dir, camForward);
    const rLen = right.length();
    if (rLen < 0.0001) {
      // fallback: pick any stable axis
      right.set(1, 0, 0);
    } else {
      right.multiplyScalar(1 / rLen);
    }

    const thickEnd = this.mat.uniforms.uThickEnd.value as number;
    const thinMid = this.mat.uniforms.uThinMid.value as number;
    const shapeK = 2.2;

    const rows = this.segments + 1;
    let p = 0;

    for (let i = 0; i < rows; i++) {
      const t = i / this.segments;

      // Hourglass width in world units
      const endWeight = Math.abs(2 * t - 1);
      const shaped = Math.pow(endWeight, shapeK);
      const w = thinMid + (thickEnd - thinMid) * shaped;

      // point along the segment
      const P = new THREE.Vector3().lerpVectors(A, B, t);

      // left/right verts
      const L = new THREE.Vector3().copy(P).addScaledVector(right, -w);
      const R = new THREE.Vector3().copy(P).addScaledVector(right, +w);

      this.positions[p++] = L.x;
      this.positions[p++] = L.y;
      this.positions[p++] = L.z;

      this.positions[p++] = R.x;
      this.positions[p++] = R.y;
      this.positions[p++] = R.z;
    }

    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose() {
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

  // scratch
  private _vA = new THREE.Vector3();
  private _vB = new THREE.Vector3();

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

  private buildOrbs() {
    // 12 unique colors (placeholder palette; you’ll likely tune later)
    const palette = [
      0x40c9ff, 0x7a5cff, 0xff4fd8, 0xff5a3c,
      0xffb74a, 0x9bff57, 0x2dffcc, 0x2aa9ff,
      0x7ef0ff, 0xa779ff, 0xff79b0, 0xffd36e,
    ].map((hex) => new THREE.Color(hex));

    for (let i = 0; i < 12; i++) {
      const color = palette[i % palette.length].clone();

      // Orb mesh
      const geo = new THREE.SphereGeometry(this.orbRadius, 32, 24);

      // Dormant “halo” look: transparent + additive rim feel (simple scaffold material)
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

      // Clock ring position in XZ plane at height y
      const t = i / 12;
      const a = t * Math.PI * 2 + this.angleOffsetRad;

      mesh.position.set(
        Math.cos(a) * this.ringRadius,
        this.y,
        Math.sin(a) * this.ringRadius
      );

      this.scene.add(mesh);

      // Filament
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

  /** Call this from your pointer handler (normalized device coords). */
  handlePointerDown(ndcX: number, ndcY: number) {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(
      this.orbs.map((o) => o.mesh),
      false
    );

    if (!hits.length) return;

    const hit = hits[0].object as THREE.Object3D;
    const id = hit.userData.constellationId as number;

    const orb = this.orbs.find((o) => o.id === id);
    if (!orb) return;

    this.onFocusRequest?.({
      id,
      object: orb.mesh,
      position: orb.mesh.getWorldPosition(new THREE.Vector3()),
    });
  }

  update(dt: number) {
    // Update filaments each frame so they face camera and stay connected.
    const corePos = this.coreObject.getWorldPosition(this._vA);

    for (const orb of this.orbs) {
      const orbPos = orb.mesh.getWorldPosition(this._vB);

      // Endpoint padding so the filament “connects” to the surfaces, not centers.
      const dir = new THREE.Vector3().subVectors(orbPos, corePos).normalize();

      const start = new THREE.Vector3().copy(corePos).addScaledVector(dir, 1.0); // tweak later
      const end = new THREE.Vector3().copy(orbPos).addScaledVector(dir, -this.orbRadius * 0.9);

      orb.filament.setColors(this.coreColor, orb.color);
      orb.filament.setEndpoints(start, end);
      //orb.filament.update(dt, this.camera);
    }
  }

  dispose() {
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
