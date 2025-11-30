// src/apps/DebugOverlay.ts

import * as THREE from "three";

export class DebugOverlay {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly container: HTMLDivElement;
  private readonly textEl: HTMLPreElement;

  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;

  private readonly hasMemoryAPI: boolean;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;

    this.container = document.createElement("div");
    this.container.className = "debug-overlay";

    this.textEl = document.createElement("pre");
    this.textEl.className = "debug-overlay-text";
    this.container.appendChild(this.textEl);

    document.body.appendChild(this.container);

    this.hasMemoryAPI =
      typeof performance !== "undefined" && "memory" in performance;
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
    ];

    this.textEl.textContent = lines.join("\n");
  }

  dispose(): void {
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }
}
