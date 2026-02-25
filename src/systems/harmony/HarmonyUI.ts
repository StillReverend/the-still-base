// src/systems/harmony/HarmonyUI.ts
// ============================================================
// THE STILL — Harmony UI (DOM only)
//  - Renders bottom player bar + harmony slide-out panel
//  - Calls handlers only (no EventBus imports)
// ============================================================

import type { HarmonyState } from "./types";
import type { RepeatMode } from "../PersistenceSystem";

type UIHandlers = {
  onTogglePlay(): void;
  onSeek(timeSec: number): void;

  // Phase 2: track navigation
  onPrevTrack(): void;
  onNextTrack(): void;

  onToggleShuffle(): void;
  onCycleRepeat(): void;

  // Legacy / optional single volume hook (kept for compatibility, not used by lane sliders)
  onSetVolume(volume01: number): void;

  onToggleEnvironmentPanel(): void;
  onSetUIVisible(visible: boolean): void;

  onToggleParticle(id: string, enabled: boolean): void;
  onToggleAmbient(id: string, enabled: boolean): void;
  onSelectColor(id: string): void;
  onSelectFilter(id: string): void;

  // ✅ Presets (Phase 1)
  onApplyPreset(presetId: string): void;

  onSetRitualDuration(durationSec: number): void;

  // ✅ Howler lane sliders (Phase 1.5)
  onSetHowlerLane?(lane: "master" | "music" | "sfx" | "ambient" | "ui", volume01: number): void;

  // ✅ Optional UI SFX hooks (HarmonySystem can wire these to EventBus)
  onUiHover?: () => void;
  onUiClick?: () => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function repeatLabel(mode: RepeatMode): string {
  if (mode === "one") return "R1";
  if (mode === "all") return "RA";
  return "R0";
}

/**
 * Safari range "fill" helper:
 * We paint the fill via background-size on the input itself using CSS var --pct.
 */
function setSliderPct(el: HTMLInputElement): void {
  const min = Number(el.min || "0");
  const max = Number(el.max || "1");
  const val = Number(el.value || "0");
  const denom = Math.max(0.000001, max - min);
  const pct = ((val - min) / denom) * 100;
  el.style.setProperty("--pct", `${pct}%`);
}

function isElementDisabled(el: HTMLElement): boolean {
  // Prefer native disabled for form controls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyEl = el as any;
  if (typeof anyEl.disabled === "boolean" && anyEl.disabled) return true;

  const aria = el.getAttribute("aria-disabled");
  if (aria === "true") return true;

  const ds = el.getAttribute("data-disabled");
  if (ds === "true") return true;

  if (el.classList.contains("is-disabled")) return true;

  return false;
}

/**
 * Attach fast, reliable button interaction:
 * - pointerdown = instant response (Safari trackpad taps included)
 * - preventDefault to avoid click delay/selection quirks
 * - keyboard fallback for accessibility (Enter/Space)
 *
 * Also supports optional UI SFX hooks:
 * - pointerenter => onHover
 * - pointerdown/Enter/Space => onClick
 */
function bindPress(
  el: HTMLElement,
  onPress: () => void,
  opts?: {
    stopPropagation?: boolean;
    onHover?: () => void;
    onClick?: () => void;
  },
): () => void {
  const stopProp = opts?.stopPropagation ?? true;

  const safeCall = (fn?: () => void) => {
    try {
      fn?.();
    } catch {
      // UI SFX should never break interaction
    }
  };

  const fire = (e?: Event) => {
    // Respect disabled state (visual + semantic)
    if (isElementDisabled(el)) return;

    if (e) {
      try {
        e.preventDefault();
      } catch {}
      if (stopProp) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e as any).stopPropagation?.();
        } catch {}
      }
    }
    onPress();
  };

  const onPointerEnter = () => {
    if (isElementDisabled(el)) return;
    safeCall(opts?.onHover);
  };

  const onPointerDown = (e: PointerEvent) => {
    // Only primary button/tap.
    if (typeof e.button === "number" && e.button !== 0) return;

    if (isElementDisabled(el)) {
      try {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any).stopPropagation?.();
      } catch {}
      return;
    }

    // SFX click should happen on down (feels snappy + counts as gesture)
    safeCall(opts?.onClick);
    fire(e);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;

    if (isElementDisabled(el)) {
      try {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any).stopPropagation?.();
      } catch {}
      return;
    }

    // Match pointerdown behavior for keyboard users
    safeCall(opts?.onClick);
    fire(e);
  };

  el.addEventListener("pointerenter", onPointerEnter);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("keydown", onKeyDown);

  return () => {
    el.removeEventListener("pointerenter", onPointerEnter);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
  };
}

// ------------------------------------------------------------
// Director vs Lumen policy + capability/unlock readers
// ------------------------------------------------------------

type HarmonyUiMode = "cinematic" | "minimal" | "full";
type HarmonyOwner = "director" | "lumen" | string;

// Matches types.ts (string capabilities)
type HarmonyCapabilityKey =
  | "playback.basic"
  | "playback.transport"
  | "playback.shuffle"
  | "playback.repeat"
  | "env.panel"
  | "env.colors"
  | "env.filters"
  | "env.particles"
  | "env.ambients"
  | "env.presets"
  | "mix.lanes"
  | "ui.hide";

type HarmonyCapabilitiesMap = Partial<Record<HarmonyCapabilityKey, boolean>>;

type HarmonyUnlocksShape = Partial<{
  colors: Record<string, boolean>;
  filters: Record<string, boolean>;
  particles: Record<string, boolean>;
  ambients: Record<string, boolean>;
  presets: Record<string, boolean>;
}>;

function readUiMode(state: HarmonyState): HarmonyUiMode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = String((state as any)?.uiMode ?? "full").toLowerCase();
  if (m === "cinematic" || m === "minimal" || m === "full") return m;
  return "full";
}

function readOwner(state: HarmonyState): HarmonyOwner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = (state as any)?.owner;
  return typeof o === "string" && o.trim() ? o.trim() : "lumen";
}

function readCaps(state: HarmonyState): HarmonyCapabilitiesMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (state as any)?.capabilities;
  if (!raw || typeof raw !== "object") return {};
  return raw as HarmonyCapabilitiesMap;
}

function capEnabled(caps: HarmonyCapabilitiesMap, key: HarmonyCapabilityKey, fallback = true): boolean {
  const v = caps[key];
  return typeof v === "boolean" ? v : fallback;
}

function readUnlocks(state: HarmonyState): HarmonyUnlocksShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = (state as any)?.unlocks;
  if (!u || typeof u !== "object") return {};
  return u as HarmonyUnlocksShape;
}

function isUnlocked(owner: HarmonyOwner, unlocks: HarmonyUnlocksShape, kind: string, id: string): boolean {
  // Director is “authoring” or “guided”; unlock gating is primarily for lumen.
  if (String(owner).toLowerCase() === "director") return true;

  const map =
    kind === "color"
      ? unlocks.colors
      : kind === "filter"
        ? unlocks.filters
        : kind === "particle"
          ? unlocks.particles
          : kind === "ambient"
            ? unlocks.ambients
            : kind === "preset"
              ? unlocks.presets
              : undefined;

  // If we have no map at all, default permissive (pre-unlock era).
  if (!map) return true;

  return Boolean(map[id]);
}

export class HarmonyUI {
  private root: HTMLDivElement;
  private bar: HTMLDivElement;
  private panel: HTMLDivElement;

  private btnPrev: HTMLButtonElement;
  private btnPlay: HTMLButtonElement;
  private btnNext: HTMLButtonElement;

  private scrub: HTMLInputElement;
  private titleText: HTMLDivElement;
  private timeText: HTMLDivElement;

  private btnShuffle: HTMLButtonElement;
  private btnRepeat: HTMLButtonElement;

  private btnEnvironment: HTMLButtonElement;
  private btnHide: HTMLButtonElement;

  // Panel: audio sliders (Howler lanes)
  private laneMaster!: HTMLInputElement;
  private laneMusic!: HTMLInputElement;
  private laneSfx!: HTMLInputElement;
  private laneAmbient!: HTMLInputElement;
  private laneUi!: HTMLInputElement;

  private handlers: UIHandlers;

  private unbinds: Array<() => void> = [];

  private isScrubbing = false;
  private scrubSeekRaf = 0;
  private scrubPendingSec: number | null = null;

  private lastDurationSec = 0;

  // Howler lane RAF batching (avoid spamming handlers)
  private laneRaf = 0;
  private lanePending: Partial<Record<"master" | "music" | "sfx" | "ambient" | "ui", number>> = {};

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
        touch-action: manipulation;
      }
      .harmony-btn:active { transform: translateY(1px); }
      .harmony-btn.on {
        border-color: rgba(255,255,255,0.30);
        background: rgba(255,255,255,0.14);
      }

      .harmony-btn.is-disabled,
      .harmony-tile.is-disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .harmony-btn.is-disabled:active,
      .harmony-tile.is-disabled:active {
        transform: none;
      }

      /* Locked tiles: subtle "seal" */
      .harmony-tile.is-locked::after {
        content: "🔒";
        position: absolute;
        right: 6px;
        top: 6px;
        font-size: 12px;
        opacity: 0.85;
        pointer-events: none;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55));
      }

      .harmony-title {
        display: flex;
        flex-direction: column;
        min-width: 160px;
        max-width: 34vw;
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

      /* Safari-proof range fill (scrub + volume + lane sliders) */
      .harmony-scrub,
      .harmony-vol,
      .harmony-lane {
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
        cursor: pointer;

        --track: rgba(255, 255, 255, 0.18);
        --fill: #d4af37;
        --pct: 0%;

        background:
          linear-gradient(var(--fill), var(--fill)) 0 50% / var(--pct) 4px no-repeat,
          linear-gradient(var(--track), var(--track)) 0 50% / 100% 4px no-repeat;
      }

      .harmony-scrub[disabled],
      .harmony-lane[disabled] {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .harmony-scrub {
        flex: 1;
        min-width: 120px;
        height: 30px;
      }

      .harmony-vol {
        width: 110px;
        height: 30px;
      }

      .harmony-lane {
        width: 100%;
        height: 30px;
      }

      .harmony-scrub::-webkit-slider-runnable-track,
      .harmony-vol::-webkit-slider-runnable-track,
      .harmony-lane::-webkit-slider-runnable-track {
        height: 4px;
        background: transparent;
        border-radius: 999px;
      }

      .harmony-scrub::-webkit-slider-thumb,
      .harmony-vol::-webkit-slider-thumb,
      .harmony-lane::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #d4af37;
        border: 2px solid rgba(0,0,0,0.4);
        margin-top: -5px;
      }

      .harmony-scrub::-moz-range-track,
      .harmony-vol::-moz-range-track,
      .harmony-lane::-moz-range-track {
        height: 4px;
        background: rgba(255, 255, 255, 0.18);
        border-radius: 999px;
      }

      .harmony-scrub::-moz-range-thumb,
      .harmony-vol::-moz-range-thumb,
      .harmony-lane::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #d4af37;
        border: 2px solid rgba(0,0,0,0.4);
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
        margin: 10px 4px 10px;
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

      /* Circle tiles (panel buttons) */
      .harmony-tile {
        position: relative;
        width: 56px;
        height: 56px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.92);
        font-size: 12px;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
        touch-action: manipulation;
      }
      .harmony-tile.on {
        border-color: rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.12);
      }

      /* Section helper for sliders */
      .harmony-sliders {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 6px 4px 10px;
      }

      .harmony-sliderRow {
        display: grid;
        grid-template-columns: 60px 1fr 44px;
        gap: 10px;
        align-items: center;
      }

      .harmony-sliderRow .k {
        font-size: 12px;
        color: rgba(255,255,255,0.70);
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .harmony-sliderRow .v {
        font-size: 12px;
        color: rgba(255,255,255,0.70);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `;

    const onHover = () => this.handlers.onUiHover?.();
    const onClick = () => this.handlers.onUiClick?.();

    // Bottom bar
    this.bar = document.createElement("div");
    this.bar.className = "harmony-bar";

    // Prev
    this.btnPrev = document.createElement("button");
    this.btnPrev.className = "harmony-btn";
    this.btnPrev.type = "button";
    this.btnPrev.textContent = "Prev";
    this.unbinds.push(bindPress(this.btnPrev, () => this.handlers.onPrevTrack(), { onHover, onClick }));

    // Play
    this.btnPlay = document.createElement("button");
    this.btnPlay.className = "harmony-btn";
    this.btnPlay.type = "button";
    this.btnPlay.textContent = "Play";
    this.unbinds.push(bindPress(this.btnPlay, () => this.handlers.onTogglePlay(), { onHover, onClick }));

    // Next
    this.btnNext = document.createElement("button");
    this.btnNext.className = "harmony-btn";
    this.btnNext.type = "button";
    this.btnNext.textContent = "Next";
    this.unbinds.push(bindPress(this.btnNext, () => this.handlers.onNextTrack(), { onHover, onClick }));

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

    // Scrub
    this.scrub = document.createElement("input");
    this.scrub.className = "harmony-scrub";
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = "1";
    this.scrub.step = "0.01";
    this.scrub.value = "0";
    setSliderPct(this.scrub);

    const scrubStart = (e?: PointerEvent) => {
      if (this.scrub.disabled) return;

      this.isScrubbing = true;

      // Capture pointer so we reliably get pointerup even if cursor leaves the control.
      if (e && typeof (this.scrub as any).setPointerCapture === "function" && e.pointerId != null) {
        try {
          this.scrub.setPointerCapture(e.pointerId);
        } catch {}
      }

      // Optional: tiny click tick when user begins scrubbing
      this.handlers.onUiClick?.();
    };

    const scrubEnd = (e?: PointerEvent) => {
      if (this.scrub.disabled) return;
      if (!this.isScrubbing) return;

      if (e && typeof (this.scrub as any).releasePointerCapture === "function" && e.pointerId != null) {
        try {
          this.scrub.releasePointerCapture(e.pointerId);
        } catch {}
      }

      const timeSec = Number(this.scrub.value);
      if (Number.isFinite(timeSec)) this.handlers.onSeek(timeSec);

      this.isScrubbing = false;
      this.scrubPendingSec = null;
      if (this.scrubSeekRaf) {
        cancelAnimationFrame(this.scrubSeekRaf);
        this.scrubSeekRaf = 0;
      }

      setSliderPct(this.scrub);
    };

    const scrubLive = () => {
      if (this.scrub.disabled) return;

      this.isScrubbing = true;

      const timeSec = Number(this.scrub.value);
      if (!Number.isFinite(timeSec)) return;

      setSliderPct(this.scrub);

      const dur = Math.max(0, this.lastDurationSec);
      this.timeText.textContent = `${formatTime(timeSec)} / ${formatTime(dur)}`;

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

    this.scrub.addEventListener("pointerenter", () => {
      if (this.scrub.disabled) return;
      this.handlers.onUiHover?.();
    });
    this.scrub.addEventListener("pointerdown", (e) => scrubStart(e));
    this.scrub.addEventListener("pointerup", (e) => scrubEnd(e));
    this.scrub.addEventListener("pointercancel", (e) => scrubEnd(e));
    this.scrub.addEventListener("lostpointercapture", () => scrubEnd());

    this.scrub.addEventListener("touchstart", () => scrubStart(), { passive: true });
    this.scrub.addEventListener("touchend", () => scrubEnd());

    this.scrub.addEventListener("input", scrubLive);
    this.scrub.addEventListener("change", () => scrubEnd());
    this.scrub.addEventListener("blur", () => scrubEnd());

    // Shuffle
    this.btnShuffle = document.createElement("button");
    this.btnShuffle.className = "harmony-btn";
    this.btnShuffle.type = "button";
    this.btnShuffle.textContent = "Shuf";
    this.unbinds.push(bindPress(this.btnShuffle, () => this.handlers.onToggleShuffle(), { onHover, onClick }));

    // Repeat
    this.btnRepeat = document.createElement("button");
    this.btnRepeat.className = "harmony-btn";
    this.btnRepeat.type = "button";
    this.btnRepeat.textContent = "R0";
    this.unbinds.push(bindPress(this.btnRepeat, () => this.handlers.onCycleRepeat(), { onHover, onClick }));

    // Environment panel
    this.btnEnvironment = document.createElement("button");
    this.btnEnvironment.className = "harmony-btn";
    this.btnEnvironment.type = "button";
    this.btnEnvironment.textContent = "Harmony";
    this.unbinds.push(bindPress(this.btnEnvironment, () => this.handlers.onToggleEnvironmentPanel(), { onHover, onClick }));

    // Hide
    this.btnHide = document.createElement("button");
    this.btnHide.className = "harmony-btn";
    this.btnHide.type = "button";
    this.btnHide.textContent = "Hide";
    this.unbinds.push(
      bindPress(this.btnHide, () => this.handlers.onSetUIVisible(false), { stopPropagation: true, onHover, onClick }),
    );

    // Order
    this.bar.appendChild(this.btnPrev);
    this.bar.appendChild(this.btnPlay);
    this.bar.appendChild(this.btnNext);
    this.bar.appendChild(titleWrap);
    this.bar.appendChild(this.scrub);
    this.bar.appendChild(this.btnShuffle);
    this.bar.appendChild(this.btnRepeat);
    this.bar.appendChild(this.btnEnvironment);
    this.bar.appendChild(this.btnHide);

    // Harmony panel
    this.panel = document.createElement("div");
    this.panel.className = "harmony-panel";

    // 1) Ritual Timer (top)
    this.panel.appendChild(
      this.makeRitualSection("Ritual", [
        ["10", 10],
        ["30", 30],
        ["60", 60],
        ["90", 90],
      ]),
    );

    // 2) Presets
    this.panel.appendChild(
      this.makePresetSection("Presets", [
        ["Dusk", "dusk"],
        ["Void", "void"],
        ["Clear", "clear"],
      ]),
    );

    // 3) Ambient (circle buttons, icons later)
    this.panel.appendChild(
      this.makeToggleSection(
        "Ambient",
        [
          ["Crickets", "crickets"],
          ["Waves", "waves"],
          ["Wind", "wind"],
          ["Chimes", "chimes"],
        ],
        (id, enabled) => this.handlers.onToggleAmbient(id, enabled),
      ),
    );

    // 4) Filters
    this.panel.appendChild(
      this.makeSelectSection("Filters", "filter", [
        ["F1", "f1", () => this.handlers.onSelectFilter("f1")],
        ["F2", "f2", () => this.handlers.onSelectFilter("f2")],
        ["F3", "f3", () => this.handlers.onSelectFilter("f3")],
        ["F4", "f4", () => this.handlers.onSelectFilter("f4")],
      ]),
    );

    // 5) ParticleFX (rename later)
    this.panel.appendChild(
      this.makeToggleSection(
        "ParticleFX",
        [
          ["Rain", "rain"],
          ["Snow", "snow"],
          ["Dust", "dust"],
          ["Embers", "embers"],
        ],
        (id, enabled) => this.handlers.onToggleParticle(id, enabled),
      ),
    );

    // 6) Spectrum placeholder
    this.panel.appendChild(
      this.makeSelectSection("Spectrum", "color", [
        ["C1", "c1", () => this.handlers.onSelectColor("c1")],
        ["C2", "c2", () => this.handlers.onSelectColor("c2")],
        ["C3", "c3", () => this.handlers.onSelectColor("c3")],
        ["C4", "c4", () => this.handlers.onSelectColor("c4")],
      ]),
    );

    // 7) Audio sliders (Howler lanes)
    this.panel.appendChild(this.makeAudioSlidersSection("Audio"));

    this.root.appendChild(style);
    this.root.appendChild(this.panel);
    this.root.appendChild(this.bar);
  }

  public mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    setSliderPct(this.scrub);
    this.syncLaneSliderFill();
  }

  public dispose(): void {
    if (this.scrubSeekRaf) cancelAnimationFrame(this.scrubSeekRaf);
    this.scrubSeekRaf = 0;
    this.scrubPendingSec = null;

    if (this.laneRaf) cancelAnimationFrame(this.laneRaf);
    this.laneRaf = 0;
    this.lanePending = {};

    for (const u of this.unbinds) u();
    this.unbinds = [];

    this.root.remove();
  }

  public render(state: HarmonyState): void {
    const uiMode = readUiMode(state);
    const owner = readOwner(state);
    const caps = readCaps(state);
    const unlocks = readUnlocks(state);

    // Root visibility
    this.root.style.display = state.uiVisible ? "block" : "none";

    // Capabilities (authoritative)
    const allowPlaybackBasic = capEnabled(caps, "playback.basic", true);
    const allowTransport = capEnabled(caps, "playback.transport", true);
    const allowShuffle = capEnabled(caps, "playback.shuffle", true);
    const allowRepeat = capEnabled(caps, "playback.repeat", true);

    const allowEnvPanel = capEnabled(caps, "env.panel", true);
    const allowEnvColors = capEnabled(caps, "env.colors", true);
    const allowEnvFilters = capEnabled(caps, "env.filters", true);
    const allowEnvParticles = capEnabled(caps, "env.particles", true);
    const allowEnvAmbients = capEnabled(caps, "env.ambients", true);
    const allowEnvPresets = capEnabled(caps, "env.presets", true);

    const allowMix = capEnabled(caps, "mix.lanes", true);
    const allowHide = capEnabled(caps, "ui.hide", true);

    // UI mode policy (visual layer)
    // - cinematic: bar only, no panel
    // - minimal: bar, panel allowed if env.panel
    // - full: normal
    const panelAllowedByMode = uiMode === "full" ? true : uiMode === "minimal" ? allowEnvPanel : false;
    const panelOpen = Boolean(state.environmentPanelOpen) && panelAllowedByMode && allowEnvPanel;
    this.panel.classList.toggle("open", panelOpen);

    // If panel can't be open, force it visually closed (without calling handlers)
    if (!panelOpen && this.panel.classList.contains("open")) {
      this.panel.classList.remove("open");
    }

    // Bottom bar controls
    this.btnPlay.textContent = state.playing ? "Pause" : "Play";
    this.titleText.textContent = state.title || "No track";

    this.btnShuffle.classList.toggle("on", !!state.shuffle);
    this.btnRepeat.textContent = repeatLabel(state.repeat);

    // Buttons
    this.setButtonEnabled(this.btnPlay, allowPlaybackBasic);
    this.setButtonEnabled(this.btnPrev, allowTransport);
    this.setButtonEnabled(this.btnNext, allowTransport);
    this.setButtonEnabled(this.btnShuffle, allowShuffle);
    this.setButtonEnabled(this.btnRepeat, allowRepeat);

    // Scrub enabled (playback.basic implies seek)
    this.scrub.disabled = !allowPlaybackBasic;

    // Environment button enabled + hidden in cinematic mode
    if (uiMode === "cinematic") {
      this.btnEnvironment.style.display = "none";
    } else {
      this.btnEnvironment.style.display = "";
      this.setButtonEnabled(this.btnEnvironment, allowEnvPanel);
    }

    // Hide button capability
    this.setButtonEnabled(this.btnHide, allowHide);

    const dur = Number.isFinite(state.durationSec) ? state.durationSec : 0;
    const pos = Number.isFinite(state.positionSec) ? state.positionSec : 0;

    this.lastDurationSec = dur;

    if (!this.isScrubbing) {
      this.timeText.textContent = `${formatTime(pos)} / ${formatTime(dur)}`;
    }

    const max = Math.max(0.01, dur);
    this.scrub.max = String(max);

    if (!this.isScrubbing) {
      this.scrub.value = String(clamp(pos, 0, max));
      setSliderPct(this.scrub);
    } else {
      setSliderPct(this.scrub);
    }

    // Toggle visuals
    this.syncToggleVisual("particle", (state.particles ?? {}) as Record<string, boolean>);
    this.syncToggleVisual("ambient", (state.ambients ?? {}) as Record<string, boolean>);

    // Select visuals (single-choice)
    this.syncSelectVisual("color", String((state as any).colorId ?? ""));
    this.syncSelectVisual("filter", String((state as any).filterId ?? ""));

    // Enable/disable sections via caps + owner/unlocks (lumen)
    this.setTilesEnabledAndLocked(owner, unlocks, "preset", allowEnvPresets);
    this.setTilesEnabled("ritual", true); // ritual currently always allowed (no capability key yet)

    this.setTilesEnabledAndLocked(owner, unlocks, "ambient", allowEnvAmbients);
    this.setTilesEnabledAndLocked(owner, unlocks, "particle", allowEnvParticles);
    this.setTilesEnabledAndLocked(owner, unlocks, "color", allowEnvColors);
    this.setTilesEnabledAndLocked(owner, unlocks, "filter", allowEnvFilters);

    // Mixer lanes
    this.setLaneEnabled(this.laneMaster, allowMix);
    this.setLaneEnabled(this.laneMusic, allowMix);
    this.setLaneEnabled(this.laneSfx, allowMix);
    this.setLaneEnabled(this.laneAmbient, allowMix);
    this.setLaneEnabled(this.laneUi, allowMix);

    // Sync lane sliders from state.mix (authoritative)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mix = (state as any).mix as
      | Partial<Record<"master" | "music" | "sfx" | "ambient" | "ui", number>>
      | undefined;

    if (mix && typeof mix === "object") {
      this.syncLaneSliderValue(this.laneMaster, mix.master);
      this.syncLaneSliderValue(this.laneMusic, mix.music);
      this.syncLaneSliderValue(this.laneSfx, mix.sfx);
      this.syncLaneSliderValue(this.laneAmbient, mix.ambient);
      this.syncLaneSliderValue(this.laneUi, mix.ui);
    }

    this.syncLaneSliderFill();

    // Helpful data hooks for debugging/QA
    this.root.setAttribute("data-owner", String(owner));
    this.root.setAttribute("data-ui-mode", String(uiMode));
  }

  private setButtonEnabled(btn: HTMLButtonElement, enabled: boolean): void {
    btn.disabled = !enabled;
    btn.classList.toggle("is-disabled", !enabled);
    btn.setAttribute("aria-disabled", enabled ? "false" : "true");
    btn.setAttribute("data-disabled", enabled ? "false" : "true");
  }

  private setLaneEnabled(el: HTMLInputElement, enabled: boolean): void {
    if (!el) return;
    el.disabled = !enabled;
    el.setAttribute("aria-disabled", enabled ? "false" : "true");
    el.setAttribute("data-disabled", enabled ? "false" : "true");
  }

  private setTilesEnabled(kind: string, enabled: boolean): void {
    const tiles = this.root.querySelectorAll<HTMLDivElement>(`.harmony-tile[data-kind="${kind}"]`);
    tiles.forEach((tile) => {
      tile.classList.toggle("is-disabled", !enabled);
      tile.setAttribute("aria-disabled", enabled ? "false" : "true");
      tile.setAttribute("data-disabled", enabled ? "false" : "true");
    });
  }

  private setTilesEnabledAndLocked(
    owner: HarmonyOwner,
    unlocks: HarmonyUnlocksShape,
    kind: string,
    enabledByCaps: boolean,
  ): void {
    const tiles = this.root.querySelectorAll<HTMLDivElement>(`.harmony-tile[data-kind="${kind}"]`);
    tiles.forEach((tile) => {
      const id = tile.dataset.id || "";
      const unlocked = id ? isUnlocked(owner, unlocks, kind, id) : true;

      const enabled = enabledByCaps && unlocked;

      tile.classList.toggle("is-disabled", !enabled);
      tile.setAttribute("aria-disabled", enabled ? "false" : "true");
      tile.setAttribute("data-disabled", enabled ? "false" : "true");

      // Lock badge for lumen when not unlocked (but only if section is otherwise allowed)
      const showLock = enabledByCaps && !unlocked && String(owner).toLowerCase() === "lumen";
      tile.classList.toggle("is-locked", showLock);
      tile.setAttribute("data-locked", showLock ? "true" : "false");
    });
  }

  private syncLaneSliderValue(el: HTMLInputElement, maybeV: unknown): void {
    if (document.activeElement === el) return;
    if (typeof maybeV !== "number" || !Number.isFinite(maybeV)) return;
    el.value = String(clamp01(maybeV));
  }

  private syncLaneSliderFill(): void {
    if (this.laneMaster) setSliderPct(this.laneMaster);
    if (this.laneMusic) setSliderPct(this.laneMusic);
    if (this.laneSfx) setSliderPct(this.laneSfx);
    if (this.laneAmbient) setSliderPct(this.laneAmbient);
    if (this.laneUi) setSliderPct(this.laneUi);
  }

  private syncToggleVisual(kind: string, map: Record<string, boolean>): void {
    const tiles = this.root.querySelectorAll<HTMLDivElement>(`.harmony-tile[data-kind="${kind}"]`);
    tiles.forEach((tile) => {
      const id = tile.dataset.id || "";
      tile.classList.toggle("on", Boolean(map[id]));
      tile.setAttribute("aria-pressed", Boolean(map[id]) ? "true" : "false");
    });
  }

  private syncSelectVisual(kind: string, selectedId: string): void {
    const tiles = this.root.querySelectorAll<HTMLDivElement>(`.harmony-tile[data-kind="${kind}"]`);
    tiles.forEach((tile) => {
      const id = tile.dataset.id || "";
      const on = id && id === selectedId;
      tile.classList.toggle("on", on);
      tile.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  private makePresetSection(label: string, presets: Array<[string, string]>): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const grid = document.createElement("div");
    grid.className = "harmony-grid";

    for (const [text, presetId] of presets) {
      const tile = document.createElement("div");
      tile.className = "harmony-tile";
      tile.textContent = text;
      tile.dataset.kind = "preset";
      tile.dataset.id = presetId;

      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.setAttribute("aria-pressed", "false");
      tile.setAttribute("aria-disabled", "false");
      tile.setAttribute("data-disabled", "false");
      tile.setAttribute("data-locked", "false");

      this.unbinds.push(
        bindPress(
          tile,
          () => {
            this.syncSelectVisual("preset", presetId);
            this.handlers.onApplyPreset(presetId);
          },
          {
            onHover: () => this.handlers.onUiHover?.(),
            onClick: () => this.handlers.onUiClick?.(),
          },
        ),
      );

      grid.appendChild(tile);
    }

    wrap.appendChild(h);
    wrap.appendChild(grid);
    return wrap;
  }

  private makeRitualSection(label: string, options: Array<[string, number]>): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const grid = document.createElement("div");
    grid.className = "harmony-grid";

    for (const [text, sec] of options) {
      const tile = document.createElement("div");
      tile.className = "harmony-tile";
      tile.textContent = text;
      tile.dataset.kind = "ritual";
      tile.dataset.id = String(sec);

      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.setAttribute("aria-disabled", "false");
      tile.setAttribute("data-disabled", "false");

      this.unbinds.push(
        bindPress(
          tile,
          () => this.handlers.onSetRitualDuration(sec),
          {
            onHover: () => this.handlers.onUiHover?.(),
            onClick: () => this.handlers.onUiClick?.(),
          },
        ),
      );

      grid.appendChild(tile);
    }

    wrap.appendChild(h);
    wrap.appendChild(grid);
    return wrap;
  }

  private makeSelectSection(
    label: string,
    kind: "color" | "filter",
    buttons: Array<[string, string, () => void]>,
  ): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const grid = document.createElement("div");
    grid.className = "harmony-grid";

    for (const [text, id, fn] of buttons) {
      const tile = document.createElement("div");
      tile.className = "harmony-tile";
      tile.textContent = text;
      tile.dataset.kind = kind;
      tile.dataset.id = id;

      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.setAttribute("aria-pressed", "false");
      tile.setAttribute("aria-disabled", "false");
      tile.setAttribute("data-disabled", "false");
      tile.setAttribute("data-locked", "false");

      this.unbinds.push(
        bindPress(
          tile,
          () => {
            this.syncSelectVisual(kind, id);
            fn();
          },
          {
            onHover: () => this.handlers.onUiHover?.(),
            onClick: () => this.handlers.onUiClick?.(),
          },
        ),
      );

      grid.appendChild(tile);
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

      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.setAttribute("aria-pressed", "false");
      tile.setAttribute("aria-disabled", "false");
      tile.setAttribute("data-disabled", "false");
      tile.setAttribute("data-locked", "false");

      const press = () => {
        const next = !tile.classList.contains("on");
        tile.classList.toggle("on", next);
        tile.setAttribute("aria-pressed", next ? "true" : "false");
        onToggle(id, next);
      };

      this.unbinds.push(
        bindPress(tile, press, {
          onHover: () => this.handlers.onUiHover?.(),
          onClick: () => this.handlers.onUiClick?.(),
        }),
      );

      grid.appendChild(tile);
    }

    wrap.appendChild(h);
    wrap.appendChild(grid);
    return wrap;
  }

  private makeAudioSlidersSection(label: string): HTMLElement {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = label;

    const box = document.createElement("div");
    box.className = "harmony-sliders";

    const onHover = () => this.handlers.onUiHover?.();
    const onClick = () => this.handlers.onUiClick?.();

    const makeLane = (key: "master" | "music" | "sfx" | "ambient" | "ui", initial: number) => {
      const row = document.createElement("div");
      row.className = "harmony-sliderRow";

      const k = document.createElement("div");
      k.className = "k";
      k.textContent = key.toUpperCase();

      const input = document.createElement("input");
      input.className = "harmony-lane";
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = String(clamp01(initial));
      setSliderPct(input);

      const v = document.createElement("div");
      v.className = "v";
      v.textContent = `${Math.round(clamp01(initial) * 100)}%`;

      const emitLane = (value01: number) => {
        const vv = clamp01(value01);
        v.textContent = `${Math.round(vv * 100)}%`;
        this.queueLaneEmit(key, vv);
      };

      input.addEventListener("pointerenter", () => {
        if (input.disabled) return;
        onHover();
      });
      input.addEventListener("pointerdown", () => {
        if (input.disabled) return;
        onClick();
      });

      input.addEventListener("input", () => {
        if (input.disabled) return;
        const vv = clamp01(Number(input.value));
        setSliderPct(input);
        emitLane(vv);
      });

      input.addEventListener("change", () => {
        if (input.disabled) return;
        const vv = clamp01(Number(input.value));
        setSliderPct(input);
        this.flushLaneEmit(key, vv);
      });

      input.addEventListener("blur", () => {
        if (input.disabled) return;
        const vv = clamp01(Number(input.value));
        setSliderPct(input);
        this.flushLaneEmit(key, vv);
      });

      row.appendChild(k);
      row.appendChild(input);
      row.appendChild(v);

      return { row, input };
    };

    const a = makeLane("master", 1.0);
    const b = makeLane("music", 1.0);
    const c = makeLane("sfx", 0.85);
    const d = makeLane("ambient", 0.7);
    const e = makeLane("ui", 0.6);

    this.laneMaster = a.input;
    this.laneMusic = b.input;
    this.laneSfx = c.input;
    this.laneAmbient = d.input;
    this.laneUi = e.input;

    box.appendChild(a.row);
    box.appendChild(b.row);
    box.appendChild(c.row);
    box.appendChild(d.row);
    box.appendChild(e.row);

    wrap.appendChild(h);
    wrap.appendChild(box);
    return wrap;
  }

  private queueLaneEmit(lane: "master" | "music" | "sfx" | "ambient" | "ui", value01: number): void {
    if (!this.handlers.onSetHowlerLane) return;

    // Don’t emit if lane control is disabled
    const el =
      lane === "master"
        ? this.laneMaster
        : lane === "music"
          ? this.laneMusic
          : lane === "sfx"
            ? this.laneSfx
            : lane === "ambient"
              ? this.laneAmbient
              : this.laneUi;

    if (el?.disabled) return;

    this.lanePending[lane] = clamp01(value01);

    if (!this.laneRaf) {
      this.laneRaf = requestAnimationFrame(() => {
        this.laneRaf = 0;

        const pending = this.lanePending;
        this.lanePending = {};

        for (const [k, v] of Object.entries(pending) as Array<[typeof lane, number]>) {
          if (typeof v === "number" && Number.isFinite(v)) {
            this.handlers.onSetHowlerLane?.(k, v);
          }
        }
      });
    }
  }

  private flushLaneEmit(lane: "master" | "music" | "sfx" | "ambient" | "ui", value01: number): void {
    if (!this.handlers.onSetHowlerLane) return;

    // Don’t emit if lane control is disabled
    const el =
      lane === "master"
        ? this.laneMaster
        : lane === "music"
          ? this.laneMusic
          : lane === "sfx"
            ? this.laneSfx
            : lane === "ambient"
              ? this.laneAmbient
              : this.laneUi;

    if (el?.disabled) return;

    this.lanePending[lane] = clamp01(value01);

    if (this.laneRaf) {
      cancelAnimationFrame(this.laneRaf);
      this.laneRaf = 0;
    }

    const pending = this.lanePending;
    this.lanePending = {};

    for (const [k, v] of Object.entries(pending) as Array<[typeof lane, number]>) {
      if (typeof v === "number" && Number.isFinite(v)) {
        this.handlers.onSetHowlerLane?.(k, v);
      }
    }
  }
}