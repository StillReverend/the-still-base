// src/core/Motion.ts
// ============================================================
// THE STILL — Motion
// ------------------------------------------------------------
// Central GSAP import wrapper.
// - Keeps GSAP imports out of gameplay systems/scenes.
// - One place to register plugins later.
// ============================================================

import { gsap } from "gsap";

export { gsap };

export type Gsap = typeof gsap;
