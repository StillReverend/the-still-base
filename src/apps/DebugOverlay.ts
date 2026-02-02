// src/apps/DebugOverlay.ts
//
// Phase 1 (DEV): EventBus tap + filtered event log (compatible with onAny payload object)
//  - E: toggle bus log panel
//  - Shift+E: include/exclude camera:telemetry in bus log (default: excluded)
//  - T: toggle the camera telemetry section in the overlay text
//
// Why this version:
//  - Our EventBus.onAny delivers a single object: { event, payload }.
//  - Previous overlay assumed (eventName, payload) and printed [object Object].
//  - This overlay supports BOTH shapes safely.

import * as THREE from "three";
import type { EventBus } from "../core/EventBus";

interface CameraTelemetryOverlay {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
  azimuthAngle: number;
  polarAngle: number;
}

type AnyBusHandler = (...args: unknown[]) => void;

type AudioFrame = {
  energy: number;
  low: number;
  mid: number;
  high: number;
};

type AudioFramePayload = {
  frame?: AudioFrame;
  isPlaying?: boolean;
  trackId?: string | null;
  atCtxTime?: number;
  reason?: string;
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!target) return false;
  const el = target as HTMLElement;

  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;

  return false;
};

const fmtClockTime = (): string => {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

const safeShort = (value: unknown, max = 140): string => {
  try {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  } catch {
    return "[unserializable]";
  }
};

const unpackAnyArgs = (args: unknown[]): { name: string; payload: unknown } | null => {
  if (args.length === 0) return null;

  // Shape A: (eventName: string, payload: unknown)
  if (typeof args[0] === "string") {
    return { name: args[0], payload: args[1] };
  }

  // Shape B: ({ event: string, payload: unknown })
  const first = args[0] as any;
  if (first && typeof first === "object" && typeof first.event === "string" && "payload" in first) {
    return { name: first.event as string, payload: first.payload as unknown };
  }

  // Unknown shape
  return { name: "[unknown-event]", payload: args[0] };
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const fmt01 = (v: unknown): string => {
  const n = typeof v === "number" && Number.isFinite(v) ? clamp01(v) : 0;
  return n.toFixed(2);
};

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

  // Audio frame (dev readout)
  private lastAudioFrame: AudioFrame | null = null;
  private lastAudioFrameIsPlaying: boolean | null = null;
  private lastAudioFrameTrackId: string | null = null;

  // DEV panels/toggles
  private showBusLog = false;
  private includeCameraTelemetryInBusLog = false; // default OFF
  private showCameraTelemetrySection = true;

  // Bus log ring buffer
  private readonly busLogMax = 18;
  private busLog: Array<{ t: string; name: string; payload: string }> = [];
  private busSkipped = 0;

  private readonly onAnyHandler: AnyBusHandler | null = null;

  private onKeyUp = (ev: KeyboardEvent): void => {
    if (!import.meta.env.DEV) return;
    if (isTypingTarget(ev.target)) return;
    if (ev.repeat) return;

    const key = ev.key.toLowerCase();

    if (key === "r") {
      this.bus.emit("debug:toggle-regions", {});
      return;
    }

    if (key === "e") {
      if (ev.shiftKey) {
        this.includeCameraTelemetryInBusLog = !this.includeCameraTelemetryInBusLog;
        return;
      }
      this.showBusLog = !this.showBusLog;
      return;
    }

    if (key === "t") {
      this.showCameraTelemetrySection = !this.showCameraTelemetrySection;
      return;
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

    this.hasMemoryAPI = typeof performance !== "undefined" && "memory" in performance;

    // Camera telemetry section (separate from bus log)
    this.bus.on<CameraTelemetryOverlay>("camera:telemetry", (payload) => {
      this.lastTelemetry = payload;
    });

    // Audio reactive readout (separate from bus log)
    this.bus.on<AudioFramePayload>("audio:frame", (payload) => {
      const f = payload?.frame;
      if (!f) return;

      this.lastAudioFrame = {
        energy: clamp01(f.energy),
        low: clamp01(f.low),
        mid: clamp01(f.mid),
        high: clamp01(f.high),
      };

      this.lastAudioFrameIsPlaying = !!payload?.isPlaying;
      this.lastAudioFrameTrackId = payload?.trackId ?? null;
    });

    if (import.meta.env.DEV) {
      const maybeBus = this.bus as unknown as { onAny?: (h: AnyBusHandler) => void };
      if (typeof maybeBus.onAny === "function") {
        this.onAnyHandler = (...args: unknown[]) => {
          const unpacked = unpackAnyArgs(args);
          if (!unpacked) return;

          const { name, payload } = unpacked;

          // Filter at CAPTURE time so early events don't get flooded.
          if (name === "camera:telemetry" && !this.includeCameraTelemetryInBusLog) {
            this.busSkipped += 1;
            return;
          }

          const entry = {
            t: fmtClockTime(),
            name,
            payload: safeShort(payload),
          };

          this.busLog.push(entry);
          if (this.busLog.length > this.busLogMax) this.busLog.shift();
        };

        maybeBus.onAny(this.onAnyHandler);
      }
    }

    if (import.meta.env.DEV) {
      window.addEventListener("keyup", this.onKeyUp);
    }
  }

  update(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames += 1;

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

    const lines: string[] = [
      "THE STILL — Debug",
      `fps: ${this.fps.toFixed(1)}`,
      memLine,
      `pos: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`,
      `dir: ${dir.x.toFixed(3)}, ${dir.y.toFixed(3)}, ${dir.z.toFixed(3)}`,
      "",
      "clock face truth:",
      "  Y-up world",
      "  clock face plane: XZ",
      "  +X = 3 o'clock, -X = 9 o'clock",
      "  +Z = 12 o'clock, -Z = 6 o'clock",
      "",
      "hotkeys:",
      "  R: toggle regions",
      "  E: toggle bus log panel",
      "  Shift+E: include camera:telemetry in bus log",
      "  T: toggle camera telemetry section",
    ];

    // Audio frame readout (if present)
    if (this.lastAudioFrame) {
      const f = this.lastAudioFrame;
      const play = this.lastAudioFrameIsPlaying ? "PLAY" : "PAUSE";
      const tr = this.lastAudioFrameTrackId ? ` "${this.lastAudioFrameTrackId}"` : "";

      lines.push(
        "",
        `audio frame: ${play}${tr}`,
        `  Energy: ${fmt01(f.energy)} Low: ${fmt01(f.low)} Mid: ${fmt01(f.mid)} High: ${fmt01(f.high)}`,
      );
    } else {
      lines.push("", "audio frame: (waiting for audio:frame)");
    }

    if (this.lastTelemetry && this.showCameraTelemetrySection) {
      lines.push(
        "",
        "camera telemetry:",
        `  dist: ${this.lastTelemetry.distance.toFixed(2)}`,
        `  az:   ${this.lastTelemetry.azimuthAngle.toFixed(3)}`,
        `  phi:  ${this.lastTelemetry.polarAngle.toFixed(3)}`,
      );
    }

    if (import.meta.env.DEV) {
      const hasOnAny = !!this.onAnyHandler;
      lines.push(
        "",
        `bus log: ${this.showBusLog ? "ON" : "OFF"} (onAny=${hasOnAny ? "yes" : "no"})`,
        `  camera:telemetry in log: ${this.includeCameraTelemetryInBusLog ? "ON" : "OFF"}`,
        `  skipped: ${this.busSkipped}`,
      );

      if (this.showBusLog) {
        lines.push("");
        for (const e of this.busLog) {
          lines.push(`  ${e.t}  ${e.name}  ${e.payload}`);
        }
      }
    }

    this.textEl.textContent = lines.join("\n");
  }

  dispose(): void {
    if (import.meta.env.DEV) {
      window.removeEventListener("keyup", this.onKeyUp);
    }

    if (import.meta.env.DEV && this.onAnyHandler) {
      const maybeBus = this.bus as unknown as { offAny?: (h: AnyBusHandler) => void };
      if (typeof maybeBus.offAny === "function") {
        maybeBus.offAny(this.onAnyHandler);
      }
    }

    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }
}
