/**
 * The perf HUD's text (P1.7) and its redraw gate, free of WebGL and troika so unit tests can run
 * them. `perf-hud.ts` feeds the values and draws the string with troika.
 *
 * The text stays printable ASCII: troika resolves a glyph missing from the local Noto Sans font
 * through a CDN, which the app never uses.
 */
import type { StrokeBand } from '../render/strokes/bands';

/** The HUD recomputes its text at 4 Hz. */
export const PERF_HUD_INTERVAL_MS = 250;

export interface PerfHudGovernor {
  /** Whether the governor judges frames; on desktop it does not, and the HUD says "gov idle". */
  judging: boolean;
  level: number;
  /** The governor's target, which drops to 72 once the fallback applies. */
  targetHz: number;
  densities: Record<StrokeBand, number>;
  foveation: number;
  fbScale: number | 'unavailable';
  /** The scale the runtime applied; null until measured. */
  fbScaleApplied: number | null;
  /** A fixed quality level, shown as "gov fixed L3" in place of the level; null under Auto. */
  fixedLevel: number | null;
}

/** An applied fb scale this close to the requested one is not shown. */
export const FB_APPLIED_TOLERANCE = 0.01;

function fbScaleText(gov: PerfHudGovernor): string {
  if (gov.fbScale === 'unavailable') return 'n/a';
  const requested = gov.fbScale.toFixed(2);
  const applied = gov.fbScaleApplied;
  if (applied === null || Math.abs(applied - gov.fbScale) <= FB_APPLIED_TOLERANCE) return requested;
  return `${requested} (applied ${applied.toFixed(2)})`;
}

export interface PerfHudValues {
  fps: number;
  meanMs: number | null;
  p99Ms: number | null;
  /** null when no GPU timer runs. */
  gpuMs: number | null;
  /** The requested target, shown when no governor runs. */
  targetHz: number;
  /** Strokes drawn after the last cull; null before a stroke batch exists. */
  visible: number | null;
  /** Chunks that passed the last cull; null before a stroke batch exists. */
  visibleChunks: number | null;
  /** null for a scene without a governor, or under `?nogov`. */
  governor: PerfHudGovernor | null;
  /** The active A/B group's line (src/diag/ab.ts); absent or null with no group active. */
  ab?: string | null;
}

function ms(value: number | null): string {
  return value === null ? '--' : value.toFixed(2);
}

export function formatPerfHud(values: PerfHudValues): string {
  const gov = values.governor;
  const gpu = values.gpuMs === null ? 'n/a' : `${values.gpuMs.toFixed(2)} ms`;
  const visible = values.visible === null ? '--' : values.visible.toLocaleString('en-US');
  const chunks =
    values.visibleChunks === null ? '--' : values.visibleChunks.toLocaleString('en-US');
  const lines = [
    `fps ${values.fps}   mean ${ms(values.meanMs)} ms   p99 ${ms(values.p99Ms)} ms`,
    `gpu ${gpu}   target ${gov ? gov.targetHz : values.targetHz} Hz`,
    `visible ${visible} strokes   ${chunks} chunks`,
  ];
  if (!gov) {
    lines.push('governor off');
  } else {
    const { near, mid, far } = gov.densities;
    const level =
      gov.fixedLevel !== null
        ? `gov fixed L${gov.fixedLevel}`
        : gov.judging
          ? `gov level ${gov.level}`
          : 'gov idle';
    lines.push(
      `${level}   near ${near.toFixed(2)}   mid ${mid.toFixed(2)}   far ${far.toFixed(2)}`,
      `foveation ${gov.foveation.toFixed(2)}   fb scale ${fbScaleText(gov)}`,
    );
  }
  if (values.ab) lines.push(values.ab);
  return lines.join('\n');
}

export interface HudUpdater {
  /** Recomputes the text when `PERF_HUD_INTERVAL_MS` has passed, and draws it only if it changed. */
  tick(now: number, sample: () => PerfHudValues): void;
  /** The text last drawn; empty before the first tick. */
  readonly text: string;
  /** Frame time of the last recompute; null before the first tick. */
  readonly updatedAt: number | null;
  readonly redraws: number;
}

export function createHudUpdater(
  draw: (text: string) => void,
  intervalMs: number = PERF_HUD_INTERVAL_MS,
): HudUpdater {
  let text = '';
  let updatedAt: number | null = null;
  let redraws = 0;
  return {
    tick(now, sample) {
      // A time before the last update is a new clock (window and XR frames), not a short gap.
      if (updatedAt !== null && now >= updatedAt && now - updatedAt < intervalMs) return;
      updatedAt = now;
      const next = formatPerfHud(sample());
      if (next === text) return;
      text = next;
      redraws++;
      draw(text);
    },
    get text() {
      return text;
    },
    get updatedAt() {
      return updatedAt;
    },
    get redraws() {
      return redraws;
    },
  };
}
