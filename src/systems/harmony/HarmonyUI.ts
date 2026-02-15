// src/systems/harmony/HarmonyUI.ts
// ============================================================
// THE STILL — Harmony UI (DOM only)
//  - Renders bottom player bar + vibe slide-out panel
//  - Calls handlers only (no EventBus imports)
// ============================================================

import type { HarmonyState } from "./types";

type UIHandlers = {
  onTogglePlay(): void;
  onSeek(timeSec: number): void;
  onToggleVibePanel(): void;
  onSetUIVisible(visible: boolean): void;

  onToggleParticle(id: string, enabled: boolean): void;
  onToggleAmbient(id: string, enabled: boolean): void;
  onSelectColor(id: string): void;
  onSelectFilter(id: string): void;

  onSetRitualDuration(durationSec: number): void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export class HarmonyUI {
  private root: HTMLDivElement;
  private bar: HTMLDivElement;
  private panel: HTMLDivElement;

  private btnPlay: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private titleText: HTMLDivElement;
  private timeText: HTMLDivElement;

  private btnVibe: HTMLButtonElement;
  private btnHide: HTMLButtonElement;

  private handlers: UIHandlers;

  // Scrub coordination:
  // - While scrubbing, render() must NOT overwrite scrub.value.
  // - During scrubbing, we emit seek continuously (live scrub) using RAF throttling.
  private isScrubbing = false;
  private scrubSeekRaf = 0;
  private scrubPendingSec: number | null = null;

  // Keep last known duration so we can update the timer text while scrubbing.
  private lastDurationSec = 0;

  constructor(handlers: UIHandlers) {
    this.handlers = handlers;

    this.root = document.createElement("div");
    this.root.id = "harmony-root";

    const style = document.createElement("style");
    style.textContent = `
      #harmony-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        z-index: 9999;
      }

      .harmony-bar {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
        background: rgba(10, 10, 14, 0.78);
        backdrop-filter: blur(10px);
        border-top: 1px solid rgba(255,255,255,0.08);
        pointer-events: auto;
      }

      .harmony-btn {
        height: 44px;
        min-width: 44px;
        padding: 0 12px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.92);
        font-size: 14px;
        cursor: pointer;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .harmony-btn:active { transform: translateY(1px); }

      .harmony-title {
        display: flex;
        flex-direction: column;
        min-width: 160px;
        max-width: 38vw;
        overflow: hidden;
      }
      .harmony-title .t {
        font-weight: 600;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: rgba(255,255,255,0.92);
      }
      .harmony-title .s {
        font-size: 12px;
        color: rgba(255,255,255,0.65);
      }

      .harmony-scrub {
        flex: 1;
        min-width: 120px;
        height: 30px;
      }

      .harmony-panel {
        position: absolute;
        right: 0;
        bottom: calc(68px + env(safe-area-inset-bottom));
        width: min(320px, 86vw);
        max-height: min(520px, 70vh);
        overflow: auto;
        pointer-events: auto;

        background: rgba(10, 10, 14, 0.82);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,0.10);
        border-right: none;
        border-radius: 16px 0 0 16px;

        transform: translateX(110%);
        transition: transform 180ms ease;
        padding: 12px;
      }
      .harmony-panel.open { transform: translateX(0); }

      .harmony-panel h3 {
        margin: 6px 4px 10px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.60);
        font-weight: 700;
      }

      .harmony-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
        padding: 4px;
      }

      .harmony-tile {
        height: 56px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.92);
        font-size: 12px;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .harmony-tile.on {
        border-color: rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.12);
      }
    `;

    // Bottom bar
    this.bar = document.createElement("div");
    this.bar.className = "harmony-bar";

    this.btnPlay = document.createElement("button");
    this.btnPlay.className = "harmony-btn";
    this.btnPlay.textContent = "Play";
    this.btnPlay.addEventListener("click", () => this.handlers.onTogglePlay());

    const titleWrap = document.createElement("div");
    titleWrap.className = "harmony-title";

    this.titleText = document.createElement("div");
    this.titleText.className = "t";
    this.titleText.textContent = "No track";

    this.timeText = document.createElement("div");
    this.timeText.className = "s";
    this.timeText.textContent = "0:00 / 0:00";

    titleWrap.appendChild(this.titleText);
    titleWrap.appendChild(this.timeText);

    this.scrub = document.createElement("input");
    this.scrub.className = "harmony-scrub";
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = "1";
    this.scrub.step = "0.01";
    this.scrub.value = "0";

    // Scrub behavior
    const scrubStart = () => {
      this.isScrubbing = true;
    };

    const scrubEnd = () => {
      // Finalize the seek on release/change.
      const timeSec = Number(this.scrub.value);
      if (Number.isFinite(timeSec)) this.handlers.onSeek(timeSec);

      this.isScrubbing = false;
      this.scrubPendingSec = null;
      if (this.scrubSeekRaf) {
        cancelAnimationFrame(this.scrubSeekRaf);
        this.scrubSeekRaf = 0;
      }
    };

    const scrubLive = () => {
      // Some browsers (trackpad, keyboard, accessibility) primarily fire "input"
      // without pointerdown/up in the way you expect.
      this.isScrubbing = true;

      const timeSec = Number(this.scrub.value);
      if (!Number.isFinite(timeSec)) return;

      // Update timer UI immediately for responsiveness.
      const dur = Math.max(0, this.lastDurationSec);
      this.timeText.textContent = `${formatTime(timeSec)} / ${formatTime(dur)}`;

      // Throttle actual seek calls to once per animation frame.
      this.scrubPendingSec = timeSec;
      if (!this.scrubSeekRaf) {
        this.scrubSeekRaf = requestAnimationFrame(() => {
          this.scrubSeekRaf = 0;
          const pending = this.scrubPendingSec;
          this.scrubPendingSec = null;
          if (pending != null && Number.isFinite(pending)) {
            this.handlers.onSeek(pending);
          }
        });
      }
    };

    // Pointer-based scrubbing
    this.scrub.addEventListener("pointerdown", scrubStart);
    this.scrub.addEventListener("pointerup", scrubEnd);
    this.scrub.addEventListener("pointercancel", scrubEnd);
    this.scrub.addEventListener("lostpointercapture", scrubEnd);

    // Touch fallback
    this.scrub.addEventListener("touchstart", scrubStart, { passive: true });
    this.scrub.addEventListener("touchend", scrubEnd);

    // Live scrubbing while playing.
    this.scrub.addEventListener("input", scrubLive);

    // Some UAs fire "change" when the drag ends (esp. keyboard adjustments).
    this.scrub.addEventListener("change", scrubEnd);

    // If focus is lost mid-drag, finalize
    this.scrub.addEventListener("blur", scrubEnd);

    this.btnVibe = document.createElement("button");
    this.btnVibe.className = "harmony-btn";
    this.btnVibe.textContent = "Vibe";
    this.btnVibe.addEventListener("click", () => this.handlers.onToggleVibePanel());

    this.btnHide = document.createElement("button");
    this.btnHide.className = "harmony-btn";
    this.btnHide.textContent = "Hide";
    this.btnHide.addEventListener("click", () => this.handlers.onSetUIVisible(false));

    this.bar.appendChild(this.btnPlay);
    this.bar.appendChild(titleWrap);
    this.bar.appendChild(this.scrub);
    this.bar.appendChild(this.btnVibe);
    this.bar.appendChild(this.btnHide);

    // Vibe panel
    this.panel = document.createElement("div");
    this.panel.className = "harmony-panel";

    this.panel.appendChild(
      this.makeSection("Color", [
        ["C1", () => this.handlers.onSelectColor("c1")],
        ["C2", () => this.handlers.onSelectColor("c2")],
        ["C3", () => this.handlers.onSelectColor("c3")],
        ["C4", () => this.handlers.onSelectColor("c4")],
      ]),
    );

    this.panel.appendChild(
      this.makeSection("Filter", [
        ["F1", () => this.handlers.onSelectFilter("f1")],
        ["F2", () => this.handlers.onSelectFilter("f2")],
        ["F3", () => this.handlers.onSelectFilter("f3")],
        ["F4", () => this.handlers.onSelectFilter("f4")],
      ]),
    );

    this.panel.appendChild(
      this.makeToggleSection(
        "Particles",
        [
          ["Rain", "rain"],
          ["Snow", "snow"],
          ["Dust", "dust"],
          ["Embers", "embers"],
        ],
        (id, enabled) => this.handlers.onToggleParticle(id, enabled),
      ),
    );

    this.panel.appendChild(
      this.makeToggleSection(
        "Ambients",
        [
          ["Crickets", "crickets"],
          ["Waves", "waves"],
          ["Wind", "wind"],
          ["Chimes", "chimes"],
        ],
        (id, enabled) => this.handlers.onToggleAmbient(id, enabled),
      ),
    );

    this.panel.appendChild(
      this.makeSection("Ritual", [
        ["30", () => this.handlers.onSetRitualDuration(30)],
        ["60", () => this.handlers.onSetRitualDuration(60)],
        ["90", () => this.handlers.onSetRitualDuration(90)],
        ["120", () => this.handlers.onSetRitualDuration(120)],
      ]),
    );

    this.root.appendChild(style);
    this.root.appendChild(this.panel);
    this.root.appendChild(this.bar);
  }

  public mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  public dispose(): void {
    if (this.scrubSeekRaf) cancelAnimationFrame(this.scrubSeekRaf);
    this.scrubSeekRaf = 0;
    this.scrubPendingSec = null;
    this.root.remove();
  }

  public render(state: HarmonyState): void {
    this.root.style.display = state.uiVisible ? "block" : "none";
    this.root.style.pointerEvents = state.uiVisible ? "auto" : "none";

    this.panel.classList.toggle("open", state.vibePanelOpen);

    this.btnPlay.textContent = state.playing ? "Pause" : "Play";
    this.titleText.textContent = state.title || "No track";

    const dur = Number.isFinite(state.durationSec) ? state.durationSec : 0;
    const pos = Number.isFinite(state.positionSec) ? state.positionSec : 0;

    this.lastDurationSec = dur;

    // If the user is actively scrubbing, we do NOT overwrite the scrub thumb.
    // We also keep the timer responsive via the "input" handler.
    if (!this.isScrubbing) {
      this.timeText.textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
    }

    const max = Math.max(0.01, dur);
    this.scrub.max = String(max);

    if (!this.isScrubbing) {
      this.scrub.value = String(clamp(pos, 0, max));
    }

    this.syncToggleVisual("particle", state.particles);
    this.syncToggleVisual("ambient", state.ambients);
  }

  private syncToggleVisual(kind: string, map: Record<string, boolean>): void {
    const tiles = this.root.querySelectorAll<HTMLDivElement>(`.harmony-tile[data-kind="${kind}"]`);
    tiles.forEach((tile) => {
      const id = tile.dataset.id || "";
      tile.classList.toggle("on", Boolean(map[id]));
    });
  }

  private makeSection(label: string, buttons: Array<[string, () => void]>): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const grid = document.createElement("div");
    grid.className = "harmony-grid";

    for (const [text, fn] of buttons) {
      const b = document.createElement("div");
      b.className = "harmony-tile";
      b.textContent = text;
      b.addEventListener("click", fn);
      grid.appendChild(b);
    }

    wrap.appendChild(h);
    wrap.appendChild(grid);
    return wrap;
  }

  private makeToggleSection(
    label: string,
    toggles: Array<[string, string]>,
    onToggle: (id: string, enabled: boolean) => void,
  ): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const grid = document.createElement("div");
    grid.className = "harmony-grid";

    const kind = label.toLowerCase().includes("particle") ? "particle" : "ambient";

    for (const [text, id] of toggles) {
      const tile = document.createElement("div");
      tile.className = "harmony-tile";
      tile.textContent = text;
      tile.dataset.kind = kind;
      tile.dataset.id = id;

      tile.addEventListener("click", () => {
        const next = !tile.classList.contains("on");
        tile.classList.toggle("on", next);
        onToggle(id, next);
      });

      grid.appendChild(tile);
    }

    wrap.appendChild(h);
    wrap.appendChild(grid);
    return wrap;
  }
}
