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

function createCanvasRoot(): HTMLCanvasElement {
  let root = document.getElementById("app");
  if (!root) {
    root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
  }

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

function main(): void {
  const canvas = createCanvasRoot();

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

  if (import.meta.env.DEV) {
    (window as unknown as { __THE_STILL_ENGINE__?: Engine }).__THE_STILL_ENGINE__ =
      engine;

    window.addEventListener("keydown", (ev) => {
      if (ev.key === "1") {
        bus.emit<{ name: SceneName }>("scene:switch", { name: "BootScene" });
      } else if (ev.key === "2") {
        bus.emit<{ name: SceneName }>("scene:switch", { name: "DemoScene" });
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `[entry] Initial scene: ${initialSceneName} (lastScene: ${
        lastScene ?? "none"
      })`,
    );
  }
}

main();
