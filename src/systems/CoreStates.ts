// ============================================================
// THE STILL — P03.1
// CoreStates.ts
// ------------------------------------------------------------
// Bolt-on visual layer for the Core.
//
// NOTE (Jan 2026 flash fix):
//  - Ring shader could produce NaNs when normalizing a zero-length tangent:
//      tangent = normalize(cross(axis, N));
//    If axis || N, cross == 0, normalize(0) => NaN on many GPUs.
//    NaNs + additive blending + bloom => intermittent “white core” flash.
//  - Fix: safe-tangent construction (fallback axis + doppler gating).
// ============================================================

import * as THREE from "three";

export type CoreStateName = "blackHole" | "sol" | "luna";

export type CoreQuality = {
  /** 0..1. 1 = max quality. Use later for adaptive/perf scaling. */
  value: number;
};

export type CoreAudioFrame = {
  /** 0..1 general energy (RMS / amplitude). */
  energy: number;
  /** 0..1 low band energy (optional). */
  low?: number;
  /** 0..1 mid band energy (optional). */
  mid?: number;
  /** 0..1 high band energy (optional). */
  high?: number;

  /**
   * Optional: peak-hold energy (0..1) from AudioSystem.
   * If present, we can use it for "big moment" visuals that linger slightly.
   */
  peak?: number;

  /**
   * Optional: onset/transient (0..1) from AudioSystem.
   * If present, we can use it for quick "note pop" hits.
   */
  onset?: number;
};

export type CoreStateTuning = {
  /** Base glow intensity multiplier for the state. */
  glowIntensity: number;
  /** Base ring brightness multiplier for the state. */
  ringIntensity: number;

  /**
   * Audio response multiplier for this state.
   * 1.0 = normal, >1.0 = stronger, <1.0 = subtler.
   * This is the "knob" to avoid revisiting logic again.
   */
  audioPunch: number;

  /** Base ring color for the state. */
  ringColor: THREE.ColorRepresentation;
  /** Base glow color for the state. */
  glowColor: THREE.ColorRepresentation;
  /** Optional: contribute real light to the scene (very subtle). */
  enableRealLight: boolean;
  /** Optional: real light intensity. */
  realLightIntensity: number;
};

export type CoreStatesDeps = {
  /** Parent group to attach to (CoreSystem's coreGroup). */
  parent: THREE.Object3D;
  /** Base radius for the core body. Should match CoreSystem's placeholder radius. */
  radius: number;
  /** Optional: initial state. */
  initialState?: CoreStateName;
  /** Optional: global tuning overrides per state. */
  tuning?: Partial<Record<CoreStateName, Partial<CoreStateTuning>>>;
};

type StateBundle = {
  name: CoreStateName;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  realLight: THREE.PointLight | null;
  tuning: CoreStateTuning;
  update: (dt: number, audio: CoreAudioFrame, quality: CoreQuality) => void;
  setVisible: (v: boolean) => void;
  dispose: () => void;
};

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
};

const defaultTuning: Record<CoreStateName, CoreStateTuning> = {
  blackHole: {
    glowIntensity: 0,
    ringIntensity: 0.79,
    audioPunch: 2.25,
    ringColor: 0xffffed,
    glowColor: 0xffffed,
    enableRealLight: true,
    realLightIntensity: 0.99,
  },
  sol: {
    glowIntensity: 0,
    ringIntensity: 0.79,
    audioPunch: 1.75,
    ringColor: 0xffdd70,
    glowColor: 0xfffdd0,
    enableRealLight: true,
    realLightIntensity: 0.99,
  },
  luna: {
    glowIntensity: 0,
    ringIntensity: 0.50,
    audioPunch: 1.75,
    ringColor: 0xffffed,
    glowColor: 0xfffdd0,
    enableRealLight: true,
    realLightIntensity: 0.99,
  },
};

function mergeTuning(base: CoreStateTuning, override?: Partial<CoreStateTuning>): CoreStateTuning {
  if (!override) return { ...base };
  return {
    glowIntensity: override.glowIntensity ?? base.glowIntensity,
    ringIntensity: override.ringIntensity ?? base.ringIntensity,
    audioPunch: override.audioPunch ?? base.audioPunch,
    ringColor: override.ringColor ?? base.ringColor,
    glowColor: override.glowColor ?? base.glowColor,
    enableRealLight: override.enableRealLight ?? base.enableRealLight,
    realLightIntensity: override.realLightIntensity ?? base.realLightIntensity,
  };
}

// ------------------------------------------------------------
// NEW: Per-state fill tuning (threshold + curve) for Sol/Luna/BlackHole
// ------------------------------------------------------------

const fillEdgesByState: Record<CoreStateName, { start: number; end: number; curve: number }> = {
  blackHole: { start: 0.85, end: 0.94, curve: 0.97 },
  sol: { start: 0.50, end: 1.26, curve: 0.53 },
  luna: { start: 0.50, end: 0.85, curve: 0.85 },
};

// ------------------------------------------------------------
// Sol Plasma Shader
// ------------------------------------------------------------

function createSolPlasmaMaterial(): THREE.ShaderMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 }, // 0..1 (later: audio)
    uColorDeep: { value: new THREE.Color(0x000000) },
    uColorMid: { value: new THREE.Color(0xd4af37) },
    uColorHot: { value: new THREE.Color(0xffffed) },
    uLightDir: { value: new THREE.Vector3(0.25, 0.8, 0.35).normalize() },
    uDetail: { value: 1.5 }, // quality knob, 0..2-ish
  };

  const vertexShader = /* glsl */ `
    varying vec3 vWPos;
    varying vec3 vObjPos;
    varying vec3 vWNormal;

    void main() {
      vec4 wPos = modelMatrix * vec4(position, 1.0);
      vWPos = wPos.xyz;
      vObjPos = position;

      vWNormal = normalize(mat3(modelMatrix) * normal);

      gl_Position = projectionMatrix * viewMatrix * wPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    precision highp float;

    uniform float uTime;
    uniform float uEnergy;
    uniform vec3  uColorDeep;
    uniform vec3  uColorMid;
    uniform vec3  uColorHot;
    uniform vec3  uLightDir;
    uniform float uDetail;

    varying vec3 vWPos;
    varying vec3 vObjPos;
    varying vec3 vWNormal;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float valueNoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);

      f = f * f * (3.0 - 2.0 * f);

      float n000 = hash(i + vec3(0.0, 0.0, 0.0));
      float n100 = hash(i + vec3(1.0, 0.0, 0.0));
      float n010 = hash(i + vec3(0.0, 1.0, 0.0));
      float n110 = hash(i + vec3(1.0, 1.0, 0.0));
      float n001 = hash(i + vec3(0.0, 0.0, 1.0));
      float n101 = hash(i + vec3(1.0, 0.0, 1.0));
      float n011 = hash(i + vec3(0.0, 1.0, 1.0));
      float n111 = hash(i + vec3(1.0, 1.0, 1.0));

      float nx00 = mix(n000, n100, f.x);
      float nx10 = mix(n010, n110, f.x);
      float nx01 = mix(n001, n101, f.x);
      float nx11 = mix(n011, n111, f.x);

      float nxy0 = mix(nx00, nx10, f.y);
      float nxy1 = mix(nx01, nx11, f.y);

      return mix(nxy0, nxy1, f.z);
    }

    float fbm(vec3 p) {
      float sum = 0.0;
      float amp = 0.55;
      float freq = 1.0;

      for (int i = 0; i < 5; i++) {
        sum += amp * valueNoise(p * freq);
        freq *= 2.02;
        amp *= 0.5;
      }
      return sum;
    }

    void main() {
      vec3 N = normalize(vWNormal);
      vec3 V = normalize(cameraPosition - vWPos);

      float t = uTime;
      float slow = t * 0.18;
      float slower = t * 0.07;

      vec3 p = normalize(vObjPos);

      float d = mix(0.85, 1.6, clamp(uDetail, 0.0, 2.0) * 0.6);

      float cell = fbm(p * (1.85 * d) + vec3(slow, slower, -slow));
      float turb = fbm(p * (5.2 * d) + vec3(-slower, slow, slower));
      float grain = fbm(p * (15.5 * d) + vec3(slow * 1.2, -slow, slower));

      float field = cell * 0.70 + turb * 0.26 + grain * 0.04;

      float lanes = smoothstep(0.48, 0.70, field);
      float hot = smoothstep(0.70, 0.92, field);

      float e = clamp(uEnergy, 0.0, 1.0);
      float contrast = mix(0.95, 1.15, e);

      vec3 col = mix(uColorDeep, uColorMid, clamp(lanes * contrast, 0.0, 1.0));
      col = mix(col, uColorHot, clamp(hot * contrast, 0.0, 1.0));

      float diff = max(dot(N, normalize(uLightDir)), 0.0);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
      float limb = pow(max(dot(N, V), 0.0), 1.0);

      float glow = 0.22 + 0.78 * pow(fres, 1.35);
      float shade = mix(0.65, 1.15, diff);
      col *= shade;
      col *= mix(0.79, 1.0, limb);
      col += glow * vec3(1.0, 0.58, 0.22) * 0.16;

      float intensity = 1.22 + e * 0.28;
      vec3 outCol = col * intensity;

      outCol = outCol / (outCol + vec3(0.65));

      float luma = dot(outCol, vec3(0.2126, 0.7152, 0.0722));
      outCol = mix(vec3(luma), outCol, 1.18);

      outCol += pow(outCol, vec3(2.2)) * 0.18;

      gl_FragColor = vec4(outCol, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
}

function createLunaRegolithMaterial(): THREE.ShaderMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 }, // 0..1
    uDetail: { value: 1.0 }, // 0..2-ish

    uBase: { value: new THREE.Color(0x8f97a6) },
    uShadow: { value: new THREE.Color(0x2b303a) },

    uRim: { value: new THREE.Color(0xe6ecff) },
    uRimStrength: { value: 0.05 },

    uCraterScale: { value: 2.1 },
    uCraterDepth: { value: 1.0 },
    uLightDir: { value: new THREE.Vector3(0.25, 0.8, 0.35).normalize() },
  };

  const vertexShader = /* glsl */ `
    varying vec3 vN;
    varying vec3 vWPos;
    varying vec3 vObjPos;

    void main() {
      vN = normalize(normalMatrix * normal);
      vec4 wPos = modelMatrix * vec4(position, 1.0);
      vWPos = wPos.xyz;
      vObjPos = position;
      gl_Position = projectionMatrix * viewMatrix * wPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    precision highp float;

    uniform float uTime;
    uniform float uEnergy;
    uniform float uDetail;
    uniform vec3  uBase;
    uniform vec3  uShadow;
    uniform vec3  uRim;
    uniform float uRimStrength;
    uniform float uCraterScale;
    uniform float uCraterDepth;
    uniform vec3  uLightDir;

    varying vec3 vN;
    varying vec3 vWPos;
    varying vec3 vObjPos;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float valueNoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float n000 = hash(i + vec3(0.0, 0.0, 0.0));
      float n100 = hash(i + vec3(1.0, 0.0, 0.0));
      float n010 = hash(i + vec3(0.0, 1.0, 0.0));
      float n110 = hash(i + vec3(1.0, 1.0, 0.0));
      float n001 = hash(i + vec3(0.0, 0.0, 1.0));
      float n101 = hash(i + vec3(1.0, 0.0, 1.0));
      float n011 = hash(i + vec3(0.0, 1.0, 1.0));
      float n111 = hash(i + vec3(1.0, 1.0, 1.0));

      float nx00 = mix(n000, n100, f.x);
      float nx10 = mix(n010, n110, f.x);
      float nx01 = mix(n001, n101, f.x);
      float nx11 = mix(n011, n111, f.x);

      float nxy0 = mix(nx00, nx10, f.y);
      float nxy1 = mix(nx01, nx11, f.y);

      return mix(nxy0, nxy1, f.z);
    }

    float fbm(vec3 p) {
      float sum = 0.0;
      float amp = 0.55;
      float freq = 1.0;
      for (int i = 0; i < 5; i++) {
        sum += amp * valueNoise(p * freq);
        freq *= 2.02;
        amp *= 0.5;
      }
      return sum;
    }

    float craterField(vec3 p, float scale, float detail) {
      vec3 q = normalize(p) * scale;

      float n1 = fbm(q * (1.20 + detail * 0.35));
      float n2 = fbm(q * (2.35 + detail * 0.65) + vec3(3.1, 1.7, -2.2));

      float basins = smoothstep(0.38, 0.78, n1);
      float rims   = smoothstep(0.62, 0.88, n2) - smoothstep(0.88, 0.985, n2);

      float field = basins * 0.85 + rims * 0.40;
      return clamp(field, 0.0, 1.0);
    }

    void main() {
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWPos);

      float e = clamp(uEnergy, 0.0, 1.0);
      float detail = clamp(uDetail, 0.0, 2.0);

      float t = uTime * 0.03;
      vec3 p = vObjPos + vec3(t, -t, t * 0.7);

      float cr = craterField(p, uCraterScale, detail);
      cr = pow(cr, 1.15);

      float pit = smoothstep(0.18, 0.78, cr);
      float rim = smoothstep(0.55, 0.90, cr) - smoothstep(0.90, 0.985, cr);

      vec3 col = mix(uBase, uShadow, pit * (1.10 * uCraterDepth));
      col += uBase * (rim * (0.12 * uCraterDepth));

      float grit = fbm(normalize(p) * (9.0 + detail * 3.0) + vec3(9.3, 1.2, 4.7));
      grit = pow(grit, 1.4);
      col *= (0.88 + 0.22 * grit);

      vec3 L = normalize(uLightDir);
      float ndl = max(dot(N, L), 0.0);

      float ambient = 0.42;
      float diff = ambient + (1.0 - ambient) * ndl;

      diff *= mix(1.0, 0.55, pit * uCraterDepth);
      diff *= (1.0 + rim * (0.20 * uCraterDepth));

      col *= mix(0.82, 1.20, diff);

      float viewRim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
      col += uRim * (viewRim * uRimStrength);

      col *= (1.0 + e * 0.02);

      col = col / (col + vec3(1.10));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
}

// ------------------------------------------------------------
// Black Hole Shader
// ------------------------------------------------------------

function createBlackHoleMaterial(): THREE.ShaderMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uDeep: { value: new THREE.Color(0x000000) },
    uTint: { value: new THREE.Color(0x171717) },
    uRim: { value: new THREE.Color(0x000000) },
    uRimStrength: { value: 0.31 },
    uSwirlStrength: { value: 0.22 },
    uDetail: { value: 1.0 },
  };

  const vertexShader = /* glsl */ `
    varying vec3 vWPos;
    varying vec3 vObjPos;
    varying vec3 vWNormal;

    void main() {
      vec4 wPos = modelMatrix * vec4(position, 1.0);
      vWPos = wPos.xyz;
      vObjPos = position;
      vWNormal = normalize(mat3(modelMatrix) * normal);

      gl_Position = projectionMatrix * viewMatrix * wPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    precision highp float;

    uniform float uTime;
    uniform float uEnergy;
    uniform vec3  uDeep;
    uniform vec3  uTint;
    uniform vec3  uRim;
    uniform float uRimStrength;
    uniform float uSwirlStrength;
    uniform float uDetail;

    varying vec3 vWPos;
    varying vec3 vObjPos;
    varying vec3 vWNormal;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float valueNoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float n000 = hash(i + vec3(0.0, 0.0, 0.0));
      float n100 = hash(i + vec3(1.0, 0.0, 0.0));
      float n010 = hash(i + vec3(0.0, 1.0, 0.0));
      float n110 = hash(i + vec3(1.0, 1.0, 0.0));
      float n001 = hash(i + vec3(0.0, 0.0, 1.0));
      float n101 = hash(i + vec3(1.0, 0.0, 1.0));
      float n011 = hash(i + vec3(0.0, 1.0, 1.0));
      float n111 = hash(i + vec3(1.0, 1.0, 1.0));

      float nx00 = mix(n000, n100, f.x);
      float nx10 = mix(n010, n110, f.x);
      float nx01 = mix(n001, n101, f.x);
      float nx11 = mix(n011, n111, f.x);

      float nxy0 = mix(nx00, nx10, f.y);
      float nxy1 = mix(nx01, nx11, f.y);

      return mix(nxy0, nxy1, f.z);
    }

    float fbm(vec3 p) {
      float sum = 0.0;
      float amp = 0.55;
      float freq = 1.0;
      for (int i = 0; i < 5; i++) {
        sum += amp * valueNoise(p * freq);
        freq *= 2.02;
        amp *= 0.5;
      }
      return sum;
    }

    void main() {
      vec3 N = normalize(vWNormal);
      vec3 V = normalize(cameraPosition - vWPos);

      float ndv = clamp(dot(N, V), 0.0, 1.0);
      float rim = pow(1.0 - ndv, 3.0);

      vec3 p = normalize(vObjPos);

      float t = uTime;
      float a = t * 0.22;
      mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
      vec3 q = p;
      q.xz = rot * q.xz;

      float d = mix(0.9, 1.8, clamp(uDetail, 0.0, 2.0) * 0.6);
      float n = fbm(q * (3.2 * d) + vec3(t * 0.05, -t * 0.03, t * 0.04));
      n = pow(n, 1.35);

      vec3 col = mix(uDeep, uTint, n * (0.18 + uSwirlStrength));

      float e = clamp(uEnergy, 0.0, 1.0);
      float horizon = smoothstep(0.55, 0.98, rim);
      float band = horizon * (0.08 + e * 0.55);   // MUCH bigger swing

      col += uRim * band * uRimStrength;

      col = col / (col + vec3(1.35));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
}

// ------------------------------------------------------------
// Glow + Ring
// ------------------------------------------------------------

type Glow = {
  group: THREE.Group;
  inner: THREE.Mesh;
  outer: THREE.Mesh;
  innerMat: THREE.MeshBasicMaterial;
  outerMat: THREE.MeshBasicMaterial;
};

function createGlow(coreRadius: number): Glow {
  const innerRadius = coreRadius * 1.02;
  const outerRadius = coreRadius * 1.42;

  const innerGeom = new THREE.SphereGeometry(innerRadius, 48, 48);
  const outerGeom = new THREE.SphereGeometry(outerRadius, 64, 64);

  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xfffdd0,
    transparent: true,
    opacity: 0.31,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xfffdd0,
    transparent: true,
    opacity: 0.31,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const inner = new THREE.Mesh(innerGeom, innerMat);
  inner.name = "CoreGlow_AuraInner";
  inner.renderOrder = 900;

  const outer = new THREE.Mesh(outerGeom, outerMat);
  outer.name = "CoreGlow_AuraOuter";
  outer.renderOrder = 899;

  const group = new THREE.Group();
  group.name = "CoreGlow_Shared";
  group.add(inner, outer);

  return { group, inner, outer, innerMat, outerMat };
}

type Ring = {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  baseOuterRadius: number;
};

function createRing(coreRadius: number): Ring {
  const baseOuterRadius = coreRadius * 1.02;
  const geom = new THREE.SphereGeometry(baseOuterRadius, 64, 64);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xfffdd0) },
      uIntensity: { value: 1.0 },
      uPower: { value: 3.1 },
      uSoft: { value: 0.79 },

      uTime: { value: 0.0 },
      uWobbleStrength: { value: 0.0 },
      uWobbleSpeed: { value: 0.7 },
      uWobbleScale: { value: 2.1 },

      uDopplerStrength: { value: 0.0 },
      uSpinAxis: { value: new THREE.Vector3(0, 1, 0) },

      // NEW: "fill" amount (0..1). 0 = normal rim ring, 1 = full-disc (sphere surface).
      // This is the knob for your "plasma ring expands inward to fill the whole sphere" vibe.
      uFill: { value: 0.0 },
      // NEW: how softly the fill blends into the rim. Higher = softer edge.
      uFillSoft: { value: 0.22 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);

        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3  uColor;
      uniform float uIntensity;
      uniform float uPower;
      uniform float uSoft;

      uniform float uTime;
      uniform float uWobbleStrength;
      uniform float uWobbleSpeed;
      uniform float uWobbleScale;

      uniform float uDopplerStrength;
      uniform vec3  uSpinAxis;

      uniform float uFill;
      uniform float uFillSoft;

      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      float valueNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);

        float n000 = hash(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));

        float nx00 = mix(n000, n100, f.x);
        float nx10 = mix(n010, n110, f.x);
        float nx01 = mix(n001, n101, f.x);
        float nx11 = mix(n011, n111, f.x);

        float nxy0 = mix(nx00, nx10, f.y);
        float nxy1 = mix(nx01, nx11, f.y);

        return mix(nxy0, nxy1, f.z);
      }

      float fbm(vec3 p) {
        float sum = 0.0;
        float amp = 0.55;
        float freq = 1.0;
        for (int i = 0; i < 4; i++) {
          sum += amp * valueNoise(p * freq);
          freq *= 2.02;
          amp *= 0.5;
        }
        return sum;
      }

      // Safe normalize: returns fallback if vector too small
      vec3 safeNormalize(vec3 v, vec3 fallbackDir) {
        float len2 = dot(v, v);
        if (len2 < 1e-8) return normalize(fallbackDir);
        return v * inversesqrt(len2);
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);

        float ndv = clamp(dot(N, V), 0.0, 1.0);

        float rimBase = 1.0 - ndv;
        float rimMask = smoothstep(0.25, 1.0, rimBase);

        float t = uTime * uWobbleSpeed;
        float n = fbm(N * uWobbleScale + vec3(t, -t * 0.8, t * 0.6));
        n = (n * 2.0 - 1.0);

        float ndvWarped = clamp(ndv + n * uWobbleStrength * rimMask, 0.0, 1.0);

        float rim = pow(1.0 - ndvWarped, uPower);
        rim = smoothstep(0.0, uSoft, rim);

        float fill = clamp(uFill, 0.0, 1.0);

        float disc = 1.0 - ndvWarped;

        float thresh = mix(1.0, 0.0, fill);

        float soft = max(0.0001, uFillSoft);
        float fillMask = smoothstep(thresh - soft, thresh + soft, disc);

        float aRing = clamp(rim * uIntensity, 0.0, 1.0);
        float aFill = clamp(fillMask * uIntensity, 0.0, 1.0) * 0.85;

        float a = clamp(max(aRing, aFill), 0.0, 1.0);

        vec3 axis = normalize(uSpinAxis);

        vec3 c = cross(axis, N);
        float cLen2 = dot(c, c);

        vec3 tangent;
        if (cLen2 < 1e-8) {
          vec3 fallback = (abs(axis.y) > 0.9) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
          tangent = safeNormalize(cross(axis, fallback), vec3(1.0, 0.0, 0.0));
        } else {
          tangent = c * inversesqrt(cLen2);
        }

        float approach = dot(tangent, V);

        float dopMask = clamp((rimMask * aRing) + (aFill * 0.25), 0.0, 1.0);

        float dopplerGate = (cLen2 < 1e-8) ? 0.0 : 1.0;

        float d = clamp(approach * uDopplerStrength * dopplerGate, -1.0, 1.0);

        vec3 cool = vec3(0.08, 0.10, 0.16);
        vec3 warm = vec3(0.16, 0.10, 0.04);

        vec3 tint = (d >= 0.0) ? cool * d : warm * (-d);

        vec3 outCol = clamp(uColor + tint * dopMask, 0.0, 1.0);

        gl_FragColor = vec4(outCol, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "CoreRing_Shared";
  mesh.renderOrder = 898;

  return { mesh, mat, baseOuterRadius };
}

// ------------------------------------------------------------
// States
// ------------------------------------------------------------

function createBlackHoleState(radius: number, tuning: CoreStateTuning): StateBundle {
  const group = new THREE.Group();
  group.name = "CoreState_blackHole";

  const coreGeom = new THREE.SphereGeometry(radius, 96, 96);
  const coreMat = createBlackHoleMaterial();

  const coreMesh = new THREE.Mesh(coreGeom, coreMat);
  coreMesh.name = "CoreSurface_blackHole";
  coreMesh.renderOrder = 100;

  const realLight = tuning.enableRealLight
    ? new THREE.PointLight(new THREE.Color(tuning.ringColor), tuning.realLightIntensity, radius * 20)
    : null;

  if (realLight) {
    realLight.name = "CoreRealLight_blackHole";
    realLight.position.set(0, 0, 0);
  }

  group.add(coreMesh);
  if (realLight) group.add(realLight);

  const setVisible = (v: boolean): void => {
    group.visible = v;
  };

  const update = (dt: number, audio: CoreAudioFrame, quality: CoreQuality): void => {
    const rawEnergy = clamp01(audio.energy ?? 0);

    const energy = clamp01(Math.pow(rawEnergy * 2.0, 0.7));

    const q = clamp01(quality.value);

    coreMat.uniforms.uTime.value += dt;
    coreMat.uniforms.uEnergy.value = energy;
    coreMat.uniforms.uDetail.value = 0.85 + q * 1.0;

    if (coreMat.uniforms.uRimStrength) {
      coreMat.uniforms.uRimStrength.value = 0.12 + energy * 0.35;
    }

    if (coreMat.uniforms.uSwirlStrength) {
      coreMat.uniforms.uSwirlStrength.value = 0.18 + energy * 0.35;
    }

    if (realLight) {
      realLight.intensity = tuning.realLightIntensity * (0.35 + energy * 0.6);
    }
  };

  const dispose = (): void => {
    group.remove(coreMesh);
    if (realLight) group.remove(realLight);
    coreGeom.dispose();
    coreMat.dispose();
  };

  return {
    name: "blackHole",
    group,
    coreMesh,
    realLight,
    tuning,
    update,
    setVisible,
    dispose,
  };
}

function createSolState(radius: number, tuning: CoreStateTuning): StateBundle {
  const group = new THREE.Group();
  group.name = "CoreState_sol";

  const coreGeom = new THREE.SphereGeometry(radius, 96, 96);
  const coreMat = createSolPlasmaMaterial();
  const coreMesh = new THREE.Mesh(coreGeom, coreMat);
  coreMesh.name = "CoreSurface_sol";
  coreMesh.renderOrder = 100;

  const realLight = tuning.enableRealLight
    ? new THREE.PointLight(new THREE.Color(tuning.ringColor), tuning.realLightIntensity, radius * 30)
    : null;

  if (realLight) {
    realLight.name = "CoreRealLight_sol";
    realLight.position.set(0, 0, 0);
  }

  group.add(coreMesh);
  if (realLight) group.add(realLight);

  const setVisible = (v: boolean): void => {
    group.visible = v;
  };

  const update = (dt: number, audio: CoreAudioFrame, quality: CoreQuality): void => {
    const energy = clamp01(audio.energy ?? 0);
    const q = clamp01(quality.value);

    (coreMat.uniforms.uTime.value as number) += dt;
    coreMat.uniforms.uEnergy.value = energy;
    coreMat.uniforms.uDetail.value = 0.85 + q * 0.9;

    if (realLight) {
      realLight.intensity = tuning.realLightIntensity * (0.6 + energy * 0.9);
    }
  };

  const dispose = (): void => {
    group.remove(coreMesh);
    if (realLight) group.remove(realLight);
    coreGeom.dispose();
    coreMat.dispose();
  };

  return {
    name: "sol",
    group,
    coreMesh,
    realLight,
    tuning,
    update,
    setVisible,
    dispose,
  };
}

function createLunaState(radius: number, tuning: CoreStateTuning): StateBundle {
  const group = new THREE.Group();
  group.name = "CoreState_luna";

  const coreGeom = new THREE.SphereGeometry(radius, 80, 80);
  const coreMat = createLunaRegolithMaterial();

  const coreMesh = new THREE.Mesh(coreGeom, coreMat);
  coreMesh.name = "CoreSurface_luna";
  coreMesh.renderOrder = 100;

  const realLight = tuning.enableRealLight
    ? new THREE.PointLight(new THREE.Color(tuning.ringColor), tuning.realLightIntensity, radius * 20)
    : null;

  if (realLight) {
    realLight.name = "CoreRealLight_luna";
    realLight.position.set(0, 0, 0);
  }

  group.add(coreMesh);
  if (realLight) group.add(realLight);

  const setVisible = (v: boolean): void => {
    group.visible = v;
  };

  const update = (dt: number, audio: CoreAudioFrame, quality: CoreQuality): void => {
    const energy = clamp01(audio.energy ?? 0);
    const q = clamp01(quality.value);

    coreMat.uniforms.uTime.value += dt;
    coreMat.uniforms.uEnergy.value = energy;
    coreMat.uniforms.uDetail.value = 0.75 + q * 1.0;

    if (realLight) {
      realLight.intensity = tuning.realLightIntensity * (0.65 + energy * 0.6);
    }
  };

  const dispose = (): void => {
    group.remove(coreMesh);
    if (realLight) group.remove(realLight);
    coreGeom.dispose();
    coreMat.dispose();
  };

  return {
    name: "luna",
    group,
    coreMesh,
    realLight,
    tuning,
    update,
    setVisible,
    dispose,
  };
}

// ------------------------------------------------------------
// CoreStates
// ------------------------------------------------------------

export class CoreStates {
  private readonly parent: THREE.Object3D;
  private readonly group: THREE.Group;
  private readonly radius: number;

  private readonly quality: CoreQuality = { value: 1 };
  private readonly states: Record<CoreStateName, StateBundle>;

  private readonly glow: Glow;
  private readonly ring: Ring;

  private active: CoreStateName;

  // ---------------------------------------------------------------------------
  // Local transient detector state (kept for compatibility/fallback)
  // ---------------------------------------------------------------------------
  private prevEnergy: number = 0;
  private notePop: number = 0; // 0..1-ish, fast-decay transient

  // NEW: local peak-hold (fallback if AudioSystem doesn't provide frame.peak)
  private peakHold: number = 0;

  constructor(deps: CoreStatesDeps) {
    this.parent = deps.parent;
    this.radius = deps.radius;

    this.group = new THREE.Group();
    this.group.name = "CoreStatesRoot";

    const tuning: Record<CoreStateName, CoreStateTuning> = {
      blackHole: mergeTuning(defaultTuning.blackHole, deps.tuning?.blackHole),
      sol: mergeTuning(defaultTuning.sol, deps.tuning?.sol),
      luna: mergeTuning(defaultTuning.luna, deps.tuning?.luna),
    };

    const blackHole = createBlackHoleState(this.radius, tuning.blackHole);
    const sol = createSolState(this.radius, tuning.sol);
    const luna = createLunaState(this.radius, tuning.luna);

    this.states = { blackHole, sol, luna };

    this.glow = createGlow(this.radius);
    this.ring = createRing(this.radius);

    this.group.add(blackHole.group);
    this.group.add(sol.group);
    this.group.add(luna.group);

    this.group.add(this.glow.group);
    this.group.add(this.ring.mesh);

    this.active = deps.initialState ?? "blackHole";

    this.states.blackHole.setVisible(this.active === "blackHole");
    this.states.sol.setVisible(this.active === "sol");
    this.states.luna.setVisible(this.active === "luna");

    this.applySharedColorFromState(this.active);

    this.parent.add(this.group);
  }

  public getRoot(): THREE.Object3D {
    return this.group;
  }

  public getActiveState(): CoreStateName {
    return this.active;
  }

  public setQuality(value: number): void {
    this.quality.value = clamp01(value);
  }

  public setState(next: CoreStateName): void {
    if (next === this.active) return;

    this.states[this.active].setVisible(false);
    this.active = next;
    this.states[this.active].setVisible(true);

    this.applySharedColorFromState(this.active);
  }

  public update(dt: number, audio?: Partial<CoreAudioFrame>): void {
    const a: CoreAudioFrame = {
      energy: clamp01(audio?.energy ?? 0),
      low: audio?.low,
      mid: audio?.mid,
      high: audio?.high,
      peak: audio?.peak,
      onset: audio?.onset,
    };

    this.states[this.active].update(dt, a, this.quality);

    if (!this.ring?.mat || !this.glow?.innerMat || !this.glow?.outerMat) return;

    const t = this.states[this.active].tuning;
    const energy = clamp01(a.energy ?? 0);

    const uni = this.ring.mat.uniforms as any;

    if (uni.uTime) {
      uni.uTime.value = (uni.uTime.value as number) + dt;
    }

    // -------------------------------------------------------------------------
    // Derive note transient:
    // - Prefer AudioSystem onset if provided
    // - Otherwise fallback to local energy-delta detector
    // -------------------------------------------------------------------------
    let onset = clamp01((a.onset as number) ?? 0);

    if (!Number.isFinite(onset) || onset <= 0) {
      const dE = Math.max(0, energy - this.prevEnergy);
      this.prevEnergy = energy;

      const decayPerSec = 8.5;
      const decay = Math.exp(-decayPerSec * Math.max(0, dt));
      this.notePop = Math.min(1, Math.max(this.notePop * decay, dE * 10.0));
      onset = clamp01(this.notePop);
    } else {
      this.prevEnergy = energy;
      this.notePop = onset;
    }

    // -------------------------------------------------------------------------
    // Peak-hold:
    // - Prefer AudioSystem peak if provided
    // - Otherwise maintain a local peakHold that decays slowly
    // -------------------------------------------------------------------------
    let peak = clamp01((a.peak as number) ?? 0);
    if (!Number.isFinite(peak) || peak <= 0) {
      const decayPerSec = 0.42;
      if (energy >= this.peakHold) this.peakHold = energy;
      else this.peakHold = Math.max(energy, this.peakHold - decayPerSec * Math.max(0, dt));
      peak = clamp01(this.peakHold);
    } else {
      this.peakHold = peak;
    }

    const punch = Math.max(0, t.audioPunch ?? 1.0);

    const e = THREE.MathUtils.clamp(energy, 0, 1);

    const sustained = Math.pow(e, 0.55);

    const transient = onset * 0.79;

    const eBoost = THREE.MathUtils.clamp((sustained + transient) * punch, 0, 3.0);

    // -------------------------------------------------------------------------
    // Ring "fill" behavior at peaks (PER-STATE tuned)
    // -------------------------------------------------------------------------
    const fillBase = peak;
    const fillSpice = onset * 0.35;
    const fillRaw = clamp01(fillBase + fillSpice);

    const f = fillEdgesByState[this.active];
    const fill = Math.pow(smoothstep01(f.start, f.end, fillRaw), f.curve);

    if (uni.uFill) uni.uFill.value = fill;

    if (uni.uFillSoft) uni.uFillSoft.value = THREE.MathUtils.clamp(0.16 + (1.0 - e) * 0.10, 0.10, 0.28);

    if (this.active === "blackHole") {
      const w = THREE.MathUtils.clamp(0.79 + eBoost * 0.015, 0.0, 0.18);
      const d = THREE.MathUtils.clamp(0.10 + eBoost * 0.06, 0.0, 0.40);

      if (uni.uWobbleStrength) uni.uWobbleStrength.value = w;
      if (uni.uWobbleSpeed) uni.uWobbleSpeed.value = 0.46;
      if (uni.uWobbleScale) uni.uWobbleScale.value = 3.0;

      if (uni.uDopplerStrength) uni.uDopplerStrength.value = d;
      if (uni.uSpinAxis) (uni.uSpinAxis.value as THREE.Vector3).set(0, 1, 0).normalize();
    } else if (this.active === "sol") {
      const w = THREE.MathUtils.clamp(0.012 + eBoost * 0.01, 0.0, 0.06);
      const d = THREE.MathUtils.clamp(0.05 + eBoost * 0.02, 0.0, 0.16);

      if (uni.uWobbleStrength) uni.uWobbleStrength.value = w;
      if (uni.uWobbleSpeed) uni.uWobbleSpeed.value = 0.75;
      if (uni.uWobbleScale) uni.uWobbleScale.value = 2.0;

      if (uni.uDopplerStrength) uni.uDopplerStrength.value = d;
      if (uni.uSpinAxis) (uni.uSpinAxis.value as THREE.Vector3).set(0, 1, 0).normalize();
    } else {
      const d = THREE.MathUtils.clamp(eBoost * 0.02, 0.0, 0.10);

      if (uni.uWobbleStrength) uni.uWobbleStrength.value = 0.0;
      if (uni.uDopplerStrength) uni.uDopplerStrength.value = d;
      if (uni.uSpinAxis) (uni.uSpinAxis.value as THREE.Vector3).set(0, 1, 0).normalize();
    }

    const innerBase = 0.14;
    const innerAmp = 0.14;
    const outerBase = 0.06;
    const outerAmp = 0.12;

    const glowGain = t.glowIntensity;
    this.glow.innerMat.opacity = THREE.MathUtils.clamp((innerBase + energy * innerAmp) * glowGain, 0, 0.65);
    this.glow.outerMat.opacity = THREE.MathUtils.clamp((outerBase + energy * outerAmp) * glowGain, 0, 0.55);

    const s = 1.0 + energy * 0.38;
    this.glow.outer.scale.setScalar(s);

    const fillBonus = 1.0 + fill * 0.55;

    const ringIntensity = (0.55 + eBoost * 1.25) * t.ringIntensity * fillBonus;

    if (uni.uIntensity) uni.uIntensity.value = THREE.MathUtils.clamp(ringIntensity, 0.0, 2.75);
  }

  public dispose(): void {
    this.parent.remove(this.group);

    this.states.blackHole.dispose();
    this.states.sol.dispose();
    this.states.luna.dispose();

    this.glow.group.remove(this.glow.inner, this.glow.outer);
    (this.glow.inner.geometry as THREE.BufferGeometry).dispose();
    (this.glow.outer.geometry as THREE.BufferGeometry).dispose();
    this.glow.innerMat.dispose();
    this.glow.outerMat.dispose();

    this.ring.mesh.geometry.dispose();
    this.ring.mat.dispose();

    this.group.clear();
  }

  private applySharedColorFromState(state: CoreStateName): void {
    const t = this.states[state].tuning;

    this.glow.innerMat.color.set(t.glowColor as any);
    this.glow.outerMat.color.set(t.glowColor as any);

    (this.ring.mat.uniforms.uColor.value as THREE.Color).set(t.ringColor as any);

    const rl = this.states[state].realLight;
    if (rl) rl.color.set(t.ringColor as any);
  }
}

// ------------------------------------------------------------
// Helpers (local)
// ------------------------------------------------------------

const smoothstep01 = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
};
