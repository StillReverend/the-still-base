# THE STILL — GUIDED EXPERIENCE

## Phase-by-Phase Modular Build Order (Full Development Plan)

This document defines the complete, modular development roadmap for building **THE STILL: Guided Experience**, including architectural scaffolding, incremental feature delivery, Git workflow, and integration of the **VIBE System** (scaffold + full implementation).

This plan assumes:

* Three.js + Vite
* Supabase backend
* WebGL primary with future WebGPU pathway
* Browser + PWA deployment
* Strict modularity: each system can be toggled on/off independently

---

# PHASE 0 — Project Setup (The Foundation)

### 0.1 Directory Setup

Create root folder:

```
/Documents/TheStill/the-still/
```

Add subfolders:

```
src/
  apps/
  core/
  systems/
  scenes/
  ui/
  assets/
public/
docs/
scripts/
```

### 0.2 Initialize Vite + Three

```
npm create vite@latest .
npm install
npm install three supabase-js zustand
npm install --save-dev vite-plugin-pwa
```

### 0.3 Git Initialization

```
git init
git add .
git commit -m "phase0: project scaffold"
git remote add origin <repo>
git push -u origin main
```

---

# PHASE 1 — Engine Spine / Scene Manager

* `Entry.ts` initializes renderer, camera, resize, clock
* `SceneManager.ts` controls loading/unloading scenes
* `EventBus.ts` for global events
* `Config.ts` stores star counts, distances, flags

**Deliverable:** App boots into a blank scene.

---

# PHASE 2 — Save System v0 (Local Only)

* Local schema for arrival date, alignment, progress, camera, etc.
* Autosave every 20s
* Export save button (dev)

**Deliverable:** Persistence survives refresh.

---

# PHASE 3 — Camera System v1 (Orbit, AT/NEAR/FAR)

* Orbit target object
* AT/NEAR/FAR standardized distances
* Fly-to easing + acceleration
* Auto-rotate after 12s

**Deliverable:** Full navigation feel.

---

# PHASE 4 — Control System v1 (Mobile-First)

* Touch: 1-finger orbit, 2-finger pan, pinch-distance
* Mouse: drag orbit, scroll zoom
* Keyboard: WASD/arrows, +/- zoom
* Accessibility: snap-to object

---

# PHASE 5 — Core System v1 (Black Hole)

* Sphere + ring + aura
* Rotation
* Pre-rendered hum
* API: `setShrinkLevel(0..12)`

---

# PHASE 6 — Starfield System v1

* FAR sphere (~20k stars)
* BAND stars (~3k stars)
* NEAR stars (~10k stars)
* Slow drift + flicker
* Occlusion zone

**Deliverable:** Galaxy backdrop.

---

# PHASE 7 — Audio System v1 (Player + FFT)

* Basic music player
* AnalyzerNode FFT for low/mid/high
* BAND star reactions

---

# PHASE 8 — UI System v1 (Scaffold)

* Minimal bottom music bar
* Slide-out drawers
* Popup hint system
* Debug panel toggle

---

# PHASE 9 — Onboarding Cinematic + Initial Choices

* Fullscreen dynamic WebGL mask system
* Arrival Date input
* Peace/Purpose selection
* Save to schema
* Cinematic release into THE STILL

---

# PHASE 10 — Constellation System v1 (Single Test Constellation)

* Data model: id, month, stars, palette, releaseStars
* Proximity hum + shimmer
* Resonant Pulse Chain mechanic
* Completion event: ignition, filaments, shockwave, 500-star nebula
* Song unlock
* Core shrink level + autosave

---

# PHASE 11 — Constellations v2 (All 12)

* Build + position all constellations
* Per-constellation hum + color palette
* Full guided progression implemented

---

# PHASE 12 — Final Cinematic + Sun Reveal

* Beacon click event
* Waypoint flythrough
* Black screen + "Final Transmission"
* STILL click → Sun transformation
* Update user save: `guidedComplete = true`

---

# PHASE 13 — Supabase Integration (Hybrid Cloud Save)

* Passwordless login via magic link
* Cloud save tables: users, saves
* Local cache + sync resolution
* Offline fallback

---

# PHASE 14 — Remnant System v1 (Private)

* Create Remnant flow
* Drift motion + home constellation bias
* Remnant cards
* Favorite flag
* Highlight "my remnants" toggle

---

# PHASE 15 — Remnant System v2 (Public + Realtime)

* Supabase public remnant table
* Realtime subscriptions
* LOD system for distant remnants
* Performance-based culling

---

# PHASE 16 — **VIBE System Scaffold** (Early Integration)

> This phase creates the underlying architecture without UI or content.

### What’s Built:

* `VibeSystem.ts` created under `/systems/vibe/`
* API endpoints:

  * `applyVibeSettings(vibeConfig)`
  * `restoreDefaultVibe()`
  * `enableVibe()` / `disableVibe()`
* Hooks into:

  * Particle System
  * Ambient Light
  * Starfield tint
  * Fog/background tone
* Save schema fields added:

```
vibe: {
  enabled: false,
  preset: null,
  starTint: null,
  ambientLight: 1.0,
  fogTone: null,
  particlePreset: null,
  density: 1.0,
  allowConstellationOverride: false
}
```

* No UI yet
* No presets yet
* Not accessible until Still Whole unlock

**Deliverable:** VIBE engine exists but is hidden.

---

# PHASE 17 — Particle System v2 (Emotional Bundles)

* Expand particle presets:

  * Fireflies
  * Rain
  * Thunder/Lightning cues
  * Embers
  * Snow
  * Falling leaves

* Link presets to VIBE System APIs

---

# PHASE 18 — **VIBE UI + Presets (Full Implementation)**

> This is when the system becomes user-facing.

### Build:

* Slide-out VIBE menu (minimal-icon design)

* Controls:

  * Starfield tint hue slider
  * Ambient light intensity
  * Fog/background tone picker
  * Particle bundle toggles
  * Particle density slider
  * "Allow constellation overrides" toggle

* Presets:

  * System presets (Rainy, Deep Space, Serene Blue, Golden Dusk)
  * User custom presets (save, rename, load, delete)

* Audio mode choices:

  * Silent ambient
  * Ambient-only
  * Music-only
  * Combined mode

### Unlock:

* Enabled only when `guidedComplete = true`
* Onboarding mini-sequence

**Deliverable:** Full-featured VIBE System live.

---

# PHASE 19 — PWA Packaging + Production Polish

* Manifest + icons
* Offline caching rules
* Mobile profiling & optimizations
* Render performance test suite
* WebGPU experimental flag

---

# PHASE 20 — Post-Launch Expansion Hooks

* Support for new POIs
* Seasonal constellations
* Remnant relationship expansions
* VIBE preset marketplace (optional)
* Global Still events

---

## Future Camera Systems (Deferred)

These are intentionally deferred systems that will sit **on top of** the current
CameraSystem + ControlSystem. They should NOT be implemented inside CameraSystem
to keep responsibilities clean.

### 1. CameraPersistenceSystem

**Goal:** Remember and restore the player’s camera framing between sessions.

- Listens to `camera:telemetry` and periodically writes camera state to SaveManager.
- On boot, reads saved state and emits one-time setup events (e.g. `camera:set-target`
  and a future “set spherical pose” hook).
- Completely decoupled from input and orbit logic.

**Why:** So The Still feels like a personal, persistent space once the core experience
is stable (later phase, after core visuals + HUD).

---

### 2. CameraPoseSystem

**Goal:** Named, reusable camera viewpoints (“poses”) with smooth transitions.

- Each Pose contains: target (x,y,z), distance/radius, and optional angles/FOV.
- Provides API like `camera:pose:go` with `{ name, duration, ease }`.
- Drives the CameraSystem by interpolating from current state to the target pose.

**Use cases:**

- “Clock face” view of the core/rings.
- Wide “Void overview” shots.
- Memory/constellation intro angles before entering a memory scene.

**Why:** Gives us a cinematic vocabulary without hardcoding positions in every scene.

---

### 3. CameraCinematicsSystem

**Goal:** Small sequencing layer for chaining camera actions into short “moments.”

- Works with action arrays like:
  - `panTo`, `zoomTo`, `orbitTo`, `shake`, etc.
- Temporarily locks player input via ControlSystem during sequences.
- Can build on top of CameraPoseSystem (start/end poses) + CameraSystem (low-level motion).

**Use cases:**

- Intro journey into The Still.
- Special memory completion sequences.
- Transitional beats between major states (Void → Whole, etc.).

**Why:** Later-phase polish for emotional, guided moments. Not needed for the early engine spine.

---

### 4. CameraLockSystem / Bounds

**Goal:** Provide higher-level constraints on what the camera is allowed to do in
specific contexts.

- Uses existing `controls:set-locks` and future options to:
  - Temporarily disable rotation or zoom.
  - Optionally clamp horizontal/vertical angles more tightly than global defaults.
- Scene-driven: e.g. lock camera during UI-heavy interactions or very focused moments.

**Why:** Prevents disorienting movement in critical scenes and supports “framed” experiences
without permanently changing the global camera config.

---

**Note:** All four systems are **explicitly deferred**. The current plan is:

- Keep CameraSystem + ControlSystem as the core foundation.
- Revisit these systems after:
  - P03+ core/clock visuals are in,
  - A few scenes are playable,
  - And the emotional beats of The Still are clearer.
