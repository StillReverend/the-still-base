// ============================================================
// THE STILL — P03
// TimeSystem.ts
// ------------------------------------------------------------
// Placeholder for audio-reactive TIME RINGS and ripple logic.
// For P03, this is a no-op shell so CoreSystem can own the
// structure without visual complexity yet.
// ============================================================

import * as THREE from "three";

export class TimeSystem {
  private readonly root: THREE.Group;

  constructor() {
    this.root = new THREE.Group();
    this.root.name = "TimeSystem";
  }

  public getRoot(): THREE.Object3D {
    return this.root;
  }

  public update(_dt: number): void {
    // No-op for now
  }

  public dispose(): void {
    // Nothing to dispose yet
  }
}
