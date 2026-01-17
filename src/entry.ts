// src/entry.ts

import "./style.css";
import * as THREE from "three";
import { createEventBus } from "./core/EventBus";
import { createDefaultConfig } from "./core/Config";
import { createSaveManager } from "./core/SaveManager";
import { Engine } from "./apps/Engine";
import type { SceneController, SceneName } from "./apps/SceneTypes";
import { BootScene } from "./scenes/BootScene";
import { DemoScene } from "./scenes/DemoScene";

// Prevent unused import removal in some setups
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _three = THREE;

// ------------------------------------------------------------
// DEV singleton guard (prevents double RAF loops after HMR)
// ------------------------------------------------------------

type GlobalWithStill = typeof window & {
  __THE_STILL_ENGINE__?: Engine;
};

function getGlobal(): GlobalWithStill {
  return window as GlobalWithStill;
}

function createOrReuseCanvas(): HTMLCanvasElement {
  let root = document.getElementById("app");
  if (!root) {
    root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
  }

  const existing = document.getElementById("the-still-canvas") as HTMLCanvasElement | null;
  if (existing) return existing;

  const canvas = document.createElement("canvas");
  canvas.id = "the-still-canvas";
  root.appendChild(canvas);
  return canvas;
}

const sceneFactories: Record<SceneName, () => SceneController> = {
  BootScene: () => new BootScene(),
  DemoScene: () => new DemoScene(),
};

function resolveScene(name: SceneName): SceneController | null {
  const factory = sceneFactories[name];
  if (!factory) return null;
  return factory();
}

function destroyExistingEngineIfAny(): void {
  const g = getGlobal();
  if (g.__THE_STILL_ENGINE__) {
    try {
      g.__THE_STILL_ENGINE__.dispose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[entry] Error disposing previous Engine (continuing).", err);
    }
    g.__THE_STILL_ENGINE__ = undefined;
  }
}

function main(): void {
  // ✅ Critical: kill any previous Engine (HMR can leave RAF running)
  destroyExistingEngineIfAny();

  const canvas = createOrReuseCanvas();

  const bus = createEventBus();
  const config = createDefaultConfig();
  const save = createSaveManager();

  const lastScene = save.get("lastScene");
  const initialSceneName: SceneName =
    lastScene && sceneFactories[lastScene] ? lastScene : "BootScene";

  const engine = new Engine({
    canvas,
    bus,
    config,
    save,
    initialSceneFactory: () => sceneFactories[initialSceneName](),
    resolveScene,
  });

  engine.start();

  // Expose in DEV for inspection and to support singleton disposal above
  if (import.meta.env.DEV) {
    getGlobal().__THE_STILL_ENGINE__ = engine;

    window.addEventListener("keydown", (ev) => {
      if (ev.key === "1") {
        bus.emit<{ name: SceneName }>("scene:switch", { name: "BootScene" });
      } else if (ev.key === "2") {
        bus.emit<{ name: SceneName }>("scene:switch", { name: "DemoScene" });
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `[entry] Initial scene: ${initialSceneName} (lastScene: ${lastScene ?? "none"})`,
    );
  }

  // ✅ HMR cleanup: ensures no zombie RAF loops survive module replacement
  // This is the single biggest “it came back after save/commit” fix in Vite dev.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hot = (import.meta as any).hot as { dispose?: (cb: () => void) => void } | undefined;
  if (hot?.dispose) {
    hot.dispose(() => {
      try {
        engine.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[entry] Error disposing Engine during HMR dispose.", err);
      }
    });
  }
}

main();
