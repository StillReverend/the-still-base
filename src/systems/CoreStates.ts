// ============================================================
// THE STILL — P03.1
// CoreStates.ts
// ------------------------------------------------------------
// Bolt-on visual layer for the Core.
//
// Responsibilities:
//  - Provide 3 core visual states:
//      * blackHole
//      * sol
//      * luna
//  - Each state includes:
//      * Core surface (sphere)
//  - Shared (single) halo elements (NOT duplicated per state):
//      * Glow aura (inner + outer shells)
//      * Light ring (rim band shell; shader-driven, not a torus)
//      * Optional real light (per-state, for now)
//  - Provide a minimal public API for CoreSystem to drive:
//      * setState(...)
//      * update(dt, audioFrame)
//      * setQuality(...)
//      * dispose()
//
// Design Notes:
//  - We intentionally DO NOT draw glow "over" the core sphere.
//    We achieve this by:
//      * Making glow shells larger than the core radius (start outside)
//      * Using depthTest:true + depthWrite:false so the core occludes glow
//        where they overlap in screen space.
//  - Glow is NOT Fresnel. It’s two additive shells with different opacities,
//    which reads as a soft radial falloff without directional gradients.
//  - Glow + ring colors are driven by active state's tuning (single shared meshes).
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
};

export type CoreStateTuning = {
  /** Base glow intensity multiplier for the state. */
  glowIntensity: number;
  /** Base ring brightness multiplier for the state. */
  ringIntensity: number;
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const defaultTuning: Record<CoreStateName, CoreStateTuning> = {
  blackHole: {
    glowIntensity: 0.0,
    ringIntensity: 1.0,
    ringColor: 0x1a1a40,
    glowColor: 0x9bbcff,
    enableRealLight: false,
    realLightIntensity: 0.0,
  },
  sol: {
    glowIntensity: 0.31,
    ringIntensity: 0.85,
    ringColor: 0xffffed,
    glowColor: 0xffa23a,
    enableRealLight: true,
    realLightIntensity: 0.35,
  },
  luna: {
    glowIntensity: 0.31,
    ringIntensity: 0.65,
    ringColor: 0xb8c6ff,
    glowColor: 0xe6ecff,
    enableRealLight: false,
    realLightIntensity: 0.0,
  },
};

function mergeTuning(
  base: CoreStateTuning,
  override?: Partial<CoreStateTuning>,
): CoreStateTuning {
  if (!override) return { ...base };
  return {
    glowIntensity: override.glowIntensity ?? base.glowIntensity,
    ringIntensity: override.ringIntensity ?? base.ringIntensity,
    ringColor: override.ringColor ?? base.ringColor,
    glowColor: override.glowColor ?? base.glowColor,
    enableRealLight: override.enableRealLight ?? base.enableRealLight,
    realLightIntensity: override.realLightIntensity ?? base.realLightIntensity,
  };
}

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
    uDetail: { value: 1.0 }, // quality knob, 0..2-ish
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

    // IMPORTANT: Darker base so bloom doesn’t flatten everything to “white ball”.
    uBase: { value: new THREE.Color(0x8f97a6) },
    uShadow: { value: new THREE.Color(0x2b303a) },

    // Rim should be subtle with bloom
    uRim: { value: new THREE.Color(0xe6ecff) },
    uRimStrength: { value: 0.05 },

    uCraterScale: { value: 2.10 },
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

      // Drift to avoid “printed texture”
      float t = uTime * 0.03;
      vec3 p = vObjPos + vec3(t, -t, t * 0.7);

      float cr = craterField(p, uCraterScale, detail);
      cr = pow(cr, 1.15);

      // Strong separation: pits and rims
      float pit = smoothstep(0.18, 0.78, cr);
      float rim = smoothstep(0.55, 0.90, cr) - smoothstep(0.90, 0.985, cr);

      // --- ALBEDO (more aggressive) ---
      // pits go much darker; rims get a modest lift
      vec3 col = mix(uBase, uShadow, pit * (1.10 * uCraterDepth));
      col += uBase * (rim * (0.12 * uCraterDepth));

      // --- MICRO CONTRAST (cheap grit) ---
      float grit = fbm(normalize(p) * (9.0 + detail * 3.0) + vec3(9.3, 1.2, 4.7));
      grit = pow(grit, 1.4);
      col *= (0.88 + 0.22 * grit);

      // --- LIGHTING with floor ---
      vec3 L = normalize(uLightDir);
      float ndl = max(dot(N, L), 0.0);

      float ambient = 0.42; // higher floor keeps body visible
      float diff = ambient + (1.0 - ambient) * ndl;

      // pits catch less light, rims slightly more
      diff *= mix(1.0, 0.55, pit * uCraterDepth);
      diff *= (1.0 + rim * (0.20 * uCraterDepth));

      col *= mix(0.82, 1.20, diff);

      // subtle view rim (bloom will amplify)
      float viewRim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
      col += uRim * (viewRim * uRimStrength);

      // tiny pulse
      col *= (1.0 + e * 0.02);

      // bloom-safe soft compression (gentle)
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
  // IMPORTANT: These start OUTSIDE the core radius so they do not tint the core.
  // The core (depthTest:true) occludes these shells where they overlap on screen.
  const innerRadius = coreRadius * 1.02;
  const outerRadius = coreRadius * 1.42;

  const innerGeom = new THREE.SphereGeometry(innerRadius, 48, 48);
  const outerGeom = new THREE.SphereGeometry(outerRadius, 64, 64);

  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.31,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
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
  // Ring is a tight band just outside the surface.
  const innerRadius = coreRadius * 1.01;
  const baseOuterRadius = coreRadius * 1.02;

  const geom = new THREE.SphereGeometry(baseOuterRadius, 64, 64);

  const mat = new THREE.ShaderMaterial({
  uniforms: {
    uColor: { value: new THREE.Color(0xffffff) },
    uIntensity: { value: 1.0 },
    uPower: { value: 3.2 },   // rim tightness (higher = thinner)
    uSoft: { value: 0.85 },   // soften/fatten the rim slightly
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

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;

    void main() {
      vec3 V = normalize(cameraPosition - vWorldPos);
      float ndv = clamp(dot(normalize(vWorldNormal), V), 0.0, 1.0);

      // Rim term: 1 at silhouette, 0 when facing camera
      float rim = pow(1.0 - ndv, uPower);

      // Soft shaping so it reads like a band, not a harsh line
      rim = smoothstep(0.0, uSoft, rim);

      float a = rim * uIntensity;

      gl_FragColor = vec4(uColor, a);
    }
  `,
  transparent: true,
  depthWrite: false,
  depthTest: true,                 // keep true so core can occlude the far side
  blending: THREE.AdditiveBlending,
  side: THREE.FrontSide,
});

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "CoreRing_Shared";
  mesh.renderOrder = 898;

  return { mesh, mat, baseOuterRadius };
}

// ------------------------------------------------------------
// States (core surface + optional real light only)
// ------------------------------------------------------------

function createBlackHoleState(radius: number, tuning: CoreStateTuning): StateBundle {
  const group = new THREE.Group();
  group.name = "CoreState_blackHole";

  const coreGeom = new THREE.SphereGeometry(radius, 64, 64);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x0b0b18,
    metalness: 0.85,
    roughness: 0.35,
    emissive: 0x000000,
  });
  const coreMesh = new THREE.Mesh(coreGeom, coreMat);
  coreMesh.name = "CoreSurface_blackHole";
  coreMesh.renderOrder = 100;

  const realLight = tuning.enableRealLight
    ? new THREE.PointLight(new THREE.Color(tuning.ringColor), tuning.realLightIntensity, radius * 25)
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

  const update = (_dt: number, _audio: CoreAudioFrame): void => {
    // Core-only state. Shared halo/ring is handled in CoreStates.update().
    if (realLight) {
      realLight.intensity = tuning.realLightIntensity;
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
    update: (dt, audio, _quality) => update(dt, audio),
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

  private readonly Glow: Glow;
  private readonly Ring: Ring;

  private active: CoreStateName;

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

    // Create per-state core surface groups (no per-state halo/ring duplication)
    const blackHole = createBlackHoleState(this.radius, tuning.blackHole);
    const sol = createSolState(this.radius, tuning.sol);
    const luna = createLunaState(this.radius, tuning.luna);

    this.states = { blackHole, sol, luna };

    // Shared halo + ring (single instances)
    this.Glow = createGlow(this.radius);
    this.Ring = createRing(this.radius);

    // Layering: core groups first, then shared halo/ring after (but depthTest controls occlusion).
    this.group.add(blackHole.group);
    this.group.add(sol.group);
    this.group.add(luna.group);
    //this.group.add(this.Glow.group);
    this.group.add(this.Ring.mesh);

    this.active = deps.initialState ?? "blackHole";

    this.states.blackHole.setVisible(this.active === "blackHole");
    this.states.sol.setVisible(this.active === "sol");
    this.states.luna.setVisible(this.active === "luna");

    // Initialize shared halo/ring colors from the active state
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
    };

    // Per-state core update (plasma, real light modulation, etc.)
    this.states[this.active].update(dt, a, this.quality);

    // Shared halo + ring response, driven by ACTIVE state's tuning
    const t = this.states[this.active].tuning;
    const energy = clamp01(a.energy ?? 0);

    // Glow opacity pulse (outer shell expands)
    const innerBase = 0.14;
    const innerAmp = 0.14;
    const outerBase = 0.06;
    const outerAmp = 0.12;

    //this.Glow.innerMat.opacity = (innerBase + energy * innerAmp) * t.glowIntensity;
    //this.Glow.outerMat.opacity = (outerBase + energy * outerAmp) * t.glowIntensity;

    const s = 1.0 + energy * 0.38;
    //this.Glow.outer.scale.setScalar(s);

    // Ring intensity + slight breathing
    this.Ring.mat.uniforms.uIntensity.value = (0.65 + energy * 0.85) * t.ringIntensity;

    // Keep time stepping available if you ever want later (no-op now)
    void dt;
  }

  public dispose(): void {
    this.parent.remove(this.group);

    // states
    this.states.blackHole.dispose();
    this.states.sol.dispose();
    this.states.luna.dispose();

    // shared glow
    this.Glow.group.remove(this.Glow.inner, this.Glow.outer);
    (this.Glow.inner.geometry as THREE.BufferGeometry).dispose();
    (this.Glow.outer.geometry as THREE.BufferGeometry).dispose();
    this.Glow.innerMat.dispose();
    this.Glow.outerMat.dispose();

    // shared ring
    this.Ring.mesh.geometry.dispose();
    this.Ring.mat.dispose();

    this.group.clear();
  }

  private applySharedColorFromState(state: CoreStateName): void {
    const t = this.states[state].tuning;

    this.Glow.innerMat.color.set(t.glowColor as any);
    this.Glow.outerMat.color.set(t.glowColor as any);

    (this.Ring.mat.uniforms.uColor.value as THREE.Color).set(t.ringColor as any);

    // If the active state has a real light, keep it colored with ring color.
    const rl = this.states[state].realLight;
    if (rl) rl.color.set(t.ringColor as any);
  }
}
