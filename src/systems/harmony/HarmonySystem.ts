// src/systems/harmony/HarmonySystem.ts
// ============================================================
// THE STILL — HarmonySystem
//  - Owns Harmony UI state
//  - Talks only through EventBus (no AudioSystem imports)
// ============================================================

import type { EventBus } from "../../core/EventBus";
import { HarmonyUI } from "./HarmonyUI";
import { HARMONY_DEFAULT_STATE, type HarmonyState, type AudioState } from "./types";

type AnyFn = (...args: any[]) => void;

export class HarmonySystem {
  private bus: EventBus;
  private ui: HarmonyUI | null = null;
  private state: HarmonyState = { ...HARMONY_DEFAULT_STATE };
  private disposers: Array<() => void> = [];

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  public init(): void {
    if (this.ui) return;

    this.ui = new HarmonyUI({
      onTogglePlay: () => {
        // Ensure browser audio is unlocked (safe even if already unlocked)
        this.emit("audio:unlock-request", {});
        // Request-style event consumed by AudioSystem
        this.emit("audio:toggle-request", { source: "harmony" });
      },

      // UI requests seeks via "audio:seek-request"
      onSeek: (timeSec) => this.emit("audio:seek-request", { timeSec, source: "harmony" }),

      onToggleVibePanel: () => this.toggleVibePanel(),
      onSetUIVisible: (visible) => this.setUIVisible(visible),

      onToggleParticle: (id, enabled) => this.toggleParticle(id, enabled),
      onToggleAmbient: (id, enabled) => this.toggleAmbient(id, enabled),
      onSelectColor: (id) => this.selectColor(id),
      onSelectFilter: (id) => this.selectFilter(id),

      onSetRitualDuration: (durationSec) => this.setRitualDuration(durationSec),
    });

    this.ui.mount(document.body);
    this.ui.render(this.state);

    // Bus subscriptions
    this.on("audio:state", (p: AudioState) => this.onAudioState(p));

    this.on("harmony:ui:setVisible", (p: { visible: boolean }) => this.setUIVisible(Boolean(p?.visible)));
    this.on("harmony:ui:toggleVisible", () => this.setUIVisible(!this.state.uiVisible));

    this.on("harmony:vibePanel:setOpen", (p: { open: boolean }) => this.setVibePanelOpen(Boolean(p?.open)));
    this.on("harmony:vibePanel:toggle", () => this.toggleVibePanel());

    // Small UX: ESC closes the vibe panel
    window.addEventListener("keydown", this.onKeyDown, { passive: true });
    this.disposers.push(() => window.removeEventListener("keydown", this.onKeyDown));
  }

  public dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];

    this.ui?.dispose();
    this.ui = null;
  }

  // ------------------------------------------------------------
  // State updates
  // ------------------------------------------------------------

  private onAudioState(payload: any): void {
    // AudioSystem emits: { state: AudioSystemState, reason }
    // Also accept a flat state payload.
    const s = payload?.state ?? payload;

    const playing = Boolean(s?.isPlaying ?? s?.playing ?? false);
    const trackId = (s?.activeTrackId ?? s?.trackId ?? null) as string | null;

    const timeSec = Number(s?.timeSec ?? s?.positionSec ?? 0);
    const durationSecRaw = Number(s?.durationSec ?? 0);

    this.state.playing = playing;
    this.state.trackId = trackId;

    // Title: prefer explicit payload.title if provided; otherwise use trackId
    this.state.title =
      typeof payload?.title === "string" && payload.title ? payload.title : trackId ?? "No track";

    this.state.positionSec = Number.isFinite(timeSec) ? timeSec : 0;
    this.state.durationSec = Number.isFinite(durationSecRaw) ? durationSecRaw : 0;

    this.render();
  }

  private setUIVisible(visible: boolean): void {
    this.state.uiVisible = visible;
    this.render();
  }

  private setVibePanelOpen(open: boolean): void {
    this.state.vibePanelOpen = open;
    this.render();
  }

  private toggleVibePanel(): void {
    this.setVibePanelOpen(!this.state.vibePanelOpen);
  }

  private selectColor(colorId: string): void {
    this.state.colorId = colorId;
    this.emit("vibe:selectColor", { colorId });
    this.render();
  }

  private selectFilter(filterId: string): void {
    this.state.filterId = filterId;
    this.emit("vibe:selectFilter", { filterId });
    this.render();
  }

  private toggleParticle(particleId: string, enabled: boolean): void {
    this.state.particles[particleId] = enabled;
    this.emit("vibe:toggleParticle", { particleId, enabled });
    this.render();
  }

  private toggleAmbient(ambientId: string, enabled: boolean): void {
    this.state.ambients[ambientId] = enabled;
    this.emit("vibe:toggleAmbient", { ambientId, enabled });
    this.render();
  }

  private setRitualDuration(durationSec: number): void {
    const clamped = Math.max(10, Math.min(600, Math.floor(durationSec)));
    this.state.ritualDurationSec = clamped;
    this.emit("ritual:setDuration", { durationSec: clamped });
    this.render();
  }

  private render(): void {
    this.ui?.render(this.state);
  }

  // ------------------------------------------------------------
  // EventBus adapter (centralized)
  // ------------------------------------------------------------

  private emit(event: string, payload?: any): void {
    this.bus.emit(event, payload);
  }

  private on(event: string, handler: AnyFn): void {
    this.bus.on(event, handler);

    this.disposers.push(() => {
      this.bus.off(event, handler);
    });
  }

  // ------------------------------------------------------------
  // UX
  // ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.state.vibePanelOpen) {
      this.setVibePanelOpen(false);
    }
  };
}
