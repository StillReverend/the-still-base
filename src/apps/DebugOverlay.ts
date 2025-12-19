// src/apps/DebugOverlay.ts

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";

interface CameraTelemetryOverlay {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
  azimuthAngle: number;
  polarAngle: number;
}

export class DebugOverlay {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly bus: EventBus;
  private readonly container: HTMLDivElement;
  private readonly textEl: HTMLPreElement;

  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;

  private readonly hasMemoryAPI: boolean;
  private lastTelemetry: CameraTelemetryOverlay | null = null;

  private onKeyDown = (ev: KeyboardEvent): void => {
    const key = ev.key.toLowerCase();

    // DEV Hotkeys
    //  - R: toggle Region wireframe
    if (key === "r") {
      this.bus.emit("debug:toggle-regions", {});
    }
  };

  constructor(camera: THREE.PerspectiveCamera, bus: EventBus) {
    this.camera = camera;
    this.bus = bus;

    this.container = document.createElement("div");
    this.container.className = "debug-overlay";

    this.textEl = document.createElement("pre");
    this.textEl.className = "debug-overlay-text";
    this.container.appendChild(this.textEl);

    document.body.appendChild(this.container);

    this.hasMemoryAPI =
      typeof performance !== "undefined" && "memory" in performance;

    this.bus.on<CameraTelemetryOverlay>("camera:telemetry", (payload) => {
      this.lastTelemetry = payload;
    });

    // DEV-only hotkeys live here so toggles are global
    if (import.meta.env.DEV) {
      window.addEventListener("keydown", this.onKeyDown);
    }
  }

  update(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames += 1;

    // Throttle DOM updates to ~4x per second
    if (this.fpsAccum < 0.25) return;

    this.fps = this.fpsFrames / this.fpsAccum;
    this.fpsAccum = 0;
    this.fpsFrames = 0;

    const pos = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);

    let memLine = "mem: n/a";
    if (this.hasMemoryAPI) {
      const mem = (performance as any).memory;
      if (
        mem &&
        typeof mem.usedJSHeapSize === "number" &&
        typeof mem.jsHeapSizeLimit === "number"
      ) {
        const used = mem.usedJSHeapSize / (1024 * 1024);
        const limit = mem.jsHeapSizeLimit / (1024 * 1024);
        memLine = `mem: ${used.toFixed(1)} / ${limit.toFixed(0)} MB`;
      }
    }

    const lines = [
      "THE STILL — Debug",
      `fps: ${this.fps.toFixed(1)}`,
      memLine,
      `pos: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`,
      `dir: ${dir.x.toFixed(3)}, ${dir.y.toFixed(3)}, ${dir.z.toFixed(3)}`,
      "",
      "hotkeys:",
      "  R: toggle regions",
    ];

    if (this.lastTelemetry) {
      lines.push(
        "",
        `dist: ${this.lastTelemetry.distance.toFixed(2)}`,
        `az: ${this.lastTelemetry.azimuthAngle.toFixed(3)}`,
        `phi: ${this.lastTelemetry.polarAngle.toFixed(3)}`
      );
    }

    this.textEl.textContent = lines.join("\n");
  }

  dispose(): void {
    if (import.meta.env.DEV) {
      window.removeEventListener("keydown", this.onKeyDown);
    }

    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }
}
