/**
 * The settings panel's controls and layout (P5.3), shared by the XR panel and the desktop DOM
 * panel so both present the same single owner for each setting. Pure: no three, no DOM.
 *
 * Panel-local metres at scale 1: the origin is the panel's centre, +X right, +Y up, and the panel
 * faces +Z. Every hit target is at least `MIN_TARGET` in both directions.
 */
import { type GovernorMode, type LadderStep, qualityLadder } from '../render/governor';
import {
  governorModeOf,
  MAX_QUALITY_LEVEL,
  type QualityLevel,
  type QualityMode,
  type Settings,
} from '../settings/schema';

export type ControlKind = 'slider' | 'segmented' | 'toggle' | 'button';
export type PanelAction = 'recenter' | 'gallery';

export interface SegmentOption {
  readonly value: string | number;
  readonly label: string;
}

export interface ControlDef {
  readonly id: string;
  readonly kind: ControlKind;
  readonly label: string;
  /** The setting it owns. Buttons own none. */
  readonly field?: keyof Settings;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly SegmentOption[];
  readonly action?: PanelAction;
  /** Hover help, for the browser title and the XR tooltip. */
  readonly help: string;
  /** Shown but never operable: the P6 volumes. */
  readonly disabled?: string;
  readonly column: 0 | 1;
  readonly row: number;
}

export const PANEL_W = 0.62;
export const PANEL_H = 0.644;
const MARGIN = 0.024;
export const COLUMN_W = (PANEL_W - 3 * MARGIN) / 2;
const COLUMN_X: readonly [number, number] = [
  -PANEL_W / 2 + MARGIN + COLUMN_W / 2,
  PANEL_W / 2 - MARGIN - COLUMN_W / 2,
];
/**
 * A control's painted border ends about 0.058 m below its row top, so this pitch leaves 6 mm
 * between it and the next row's label.
 */
export const ROW_PITCH = 0.064;
const ROWS_TOP = PANEL_H / 2 - 0.095;
/** Height of every slider, segment and toggle target. */
export const CONTROL_H = 0.032;
const TOGGLE_W = 0.074;
const BUTTON_H = 0.048;
/** Smallest hit target side, metres at scale 1 (the brief's 2.5 cm). */
export const MIN_TARGET = 0.025;
export const TITLE_Y = PANEL_H / 2 - MARGIN - 0.012;
export const HEADER_Y = PANEL_H / 2 - 0.072;

/** The quality level slider's position for Auto, left of level 0. */
export const AUTO_SLIDER = -1;

/** Short labels: three segments share one column, about 9 cm each; the help text spells them out. */
const QUALITY_OPTIONS: readonly SegmentOption[] = [
  { value: 'adaptive-72', label: '72 Hz' },
  { value: 'adaptive-90', label: '90 Hz' },
  { value: 'beauty-72', label: 'Beauty' },
];

export const CONTROLS: readonly ControlDef[] = [
  {
    id: 'moveSpeed',
    kind: 'slider',
    label: 'Move speed',
    field: 'moveSpeed',
    min: 1,
    max: 3,
    step: 0.1,
    help: 'Smooth movement speed at full stick',
    column: 0,
    row: 0,
  },
  {
    id: 'turnMode',
    kind: 'segmented',
    label: 'Turning',
    field: 'turnMode',
    options: [
      { value: 'snap', label: 'Snap' },
      { value: 'smooth', label: 'Smooth' },
    ],
    help: 'Right stick turns in steps, or continuously',
    column: 0,
    row: 1,
  },
  {
    id: 'snapAngleDeg',
    kind: 'segmented',
    label: 'Snap step',
    field: 'snapAngleDeg',
    options: [
      { value: 30, label: '30°' },
      { value: 45, label: '45°' },
    ],
    help: 'How far one snap turn goes',
    column: 0,
    row: 2,
  },
  {
    id: 'vignette',
    kind: 'slider',
    label: 'Comfort vignette',
    field: 'vignette',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'Darkens the edge of view while moving. 0 turns it off',
    column: 0,
    row: 3,
  },
  {
    id: 'seated',
    kind: 'toggle',
    label: 'Seated',
    field: 'seated',
    help: 'Sets a seated view to the standing height',
    column: 0,
    row: 4,
  },
  {
    id: 'standingHeight',
    kind: 'slider',
    label: 'Standing height',
    field: 'standingHeight',
    min: 1,
    max: 2.2,
    step: 0.01,
    help: 'The eye height seated mode sets, raising or lowering you',
    column: 0,
    row: 5,
  },
  {
    id: 'handOrbs',
    kind: 'toggle',
    label: 'Hand orbs',
    field: 'handOrbs',
    help: 'A soft glow at each hand',
    column: 0,
    row: 6,
  },
  {
    id: 'calm',
    kind: 'slider',
    label: 'Painting motion',
    field: 'calm',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'How much the sky, stars and cypress move. 0 holds them still',
    column: 1,
    row: 0,
  },
  {
    id: 'quality',
    kind: 'segmented',
    label: 'Quality',
    field: 'quality',
    options: QUALITY_OPTIONS,
    help: '72 or 90 Hz with the adaptive governor, or beauty: 72 Hz at the highest stroke count',
    column: 1,
    row: 1,
  },
  {
    id: 'qualityLevel',
    kind: 'slider',
    label: 'Quality level',
    field: 'qualityLevel',
    // -1 is Auto; the max follows the session's quality (`liveSliderDef`).
    min: AUTO_SLIDER,
    max: MAX_QUALITY_LEVEL,
    step: 1,
    help: 'Auto adapts. Level N fixes the first N governor steps, and each level keeps every step below it: fov 0.5, fb 0.85, fov 1, then far, mid, near density',
    column: 1,
    row: 5,
  },
  {
    id: 'hud',
    kind: 'toggle',
    label: 'Performance HUD',
    field: 'hud',
    help: 'Frame rate and stroke counts below the view',
    column: 1,
    row: 2,
  },
  {
    id: 'musicVolume',
    kind: 'slider',
    label: 'Music',
    field: 'musicVolume',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'Music volume',
    column: 1,
    row: 3,
  },
  {
    id: 'sfxVolume',
    kind: 'slider',
    label: 'Sound effects',
    field: 'sfxVolume',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'Sound effects volume',
    column: 1,
    row: 4,
  },
  {
    id: 'recenter',
    kind: 'button',
    label: 'Recenter',
    action: 'recenter',
    help: 'Turn to face the painting and bring this panel in front of you',
    column: 0,
    row: 6,
  },
  {
    id: 'gallery',
    kind: 'button',
    label: 'Return to gallery',
    action: 'gallery',
    help: 'Leave the painting for the gallery',
    column: 1,
    row: 6,
  },
];

export interface Rect {
  /** Centre, metres. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ControlLayout {
  readonly def: ControlDef;
  /** The whole hit target. */
  readonly rect: Rect;
  /** Segments, left to right; empty unless segmented. */
  readonly segments: readonly Rect[];
  /** The label's left baseline anchor (top-left), metres. */
  readonly labelAt: readonly [number, number];
  /** The value's right anchor (top-right), metres. */
  readonly valueAt: readonly [number, number];
}

function rowTop(row: number): number {
  return ROWS_TOP - row * ROW_PITCH;
}

function layoutControl(def: ControlDef): ControlLayout {
  const cx = COLUMN_X[def.column];
  const left = cx - COLUMN_W / 2;
  if (def.kind === 'button') {
    const y = -PANEL_H / 2 + MARGIN + BUTTON_H / 2;
    return {
      def,
      rect: { x: cx, y, w: COLUMN_W, h: BUTTON_H },
      segments: [],
      labelAt: [cx, y],
      valueAt: [cx, y],
    };
  }
  const top = rowTop(def.row);
  const y = top - 0.04;
  const labelAt: [number, number] = [left, top];
  const valueAt: [number, number] = [left + COLUMN_W, top];
  if (def.kind === 'toggle') {
    return {
      def,
      rect: { x: left + TOGGLE_W / 2, y, w: TOGGLE_W, h: CONTROL_H },
      segments: [],
      labelAt,
      valueAt,
    };
  }
  const rect = { x: cx, y, w: COLUMN_W, h: CONTROL_H };
  const n = def.options?.length ?? 0;
  const segW = n > 0 ? COLUMN_W / n : 0;
  const segments = Array.from({ length: n }, (_, i) => ({
    x: left + segW * (i + 0.5),
    y,
    w: segW,
    h: CONTROL_H,
  }));
  return { def, rect, segments, labelAt, valueAt };
}

export const LAYOUT: readonly ControlLayout[] = CONTROLS.map(layoutControl);

export function controlLayout(id: string): ControlLayout | undefined {
  return LAYOUT.find((c) => c.def.id === id);
}

/**
 * Controls the panel hides (P5.5: Return to gallery outside a painting's world). A hidden control
 * takes no hits, so it has no hover or tooltip, and a button left alone on the button row moves to
 * the row's centre.
 */
const hiddenControls = new Set<string>();

export function setControlHidden(id: string, hidden: boolean): void {
  if (hidden) hiddenControls.add(id);
  else hiddenControls.delete(id);
}

export function controlHidden(id: string): boolean {
  return hiddenControls.has(id);
}

/** Where `layout` draws and takes hits now: its own rect, or the row's centre for a lone button. */
export function controlRect(layout: ControlLayout): Rect {
  const { def, rect } = layout;
  if (def.kind !== 'button') return rect;
  const alone = LAYOUT.every(
    (other) => other === layout || other.def.kind !== 'button' || hiddenControls.has(other.def.id),
  );
  return alone ? { ...rect, x: 0 } : rect;
}

function inside(rect: Rect, x: number, y: number): boolean {
  return Math.abs(x - rect.x) <= rect.w / 2 && Math.abs(y - rect.y) <= rect.h / 2;
}

export interface ControlHit {
  readonly id: string;
  /** The segment under the point, or -1. */
  readonly segment: number;
  /** A slider's value fraction at the point, 0-1, or -1. */
  readonly fraction: number;
}

/** A slider's fraction at panel-local x, clamped to 0-1. */
export function sliderFraction(layout: ControlLayout, x: number): number {
  const f = (x - (layout.rect.x - layout.rect.w / 2)) / layout.rect.w;
  return Math.min(1, Math.max(0, f));
}

/** The control under panel-local (x, y), or null for the bare backing. */
export function hitControl(x: number, y: number): ControlHit | null {
  for (const layout of LAYOUT) {
    if (hiddenControls.has(layout.def.id) || !inside(controlRect(layout), x, y)) continue;
    const segment = layout.segments.findIndex((s) => inside(s, x, y));
    const fraction = layout.def.kind === 'slider' ? sliderFraction(layout, x) : -1;
    return { id: layout.def.id, segment, fraction };
  }
  return null;
}

/** A slider's stored value for `fraction`, on its step. */
export function sliderValue(def: ControlDef, fraction: number): number {
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  const step = def.step ?? 0.01;
  const raw = min + Math.min(1, Math.max(0, fraction)) * (max - min);
  const stepped = Math.round((raw - min) / step) * step + min;
  // Round off float noise from the step arithmetic (0.1 * 3 is 0.30000000000000004).
  return Math.min(max, Math.max(min, Math.round(stepped * 1e6) / 1e6));
}

/** A slider value's fraction along its track. */
export function sliderPosition(def: ControlDef, value: number): number {
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
}

/**
 * The governor mode whose ladder the quality level row shows: the bound governor's own, so the row
 * and the governor never disagree, or with none bound the mode the next one starts in.
 */
export function ladderMode(bound: GovernorMode | null, quality: QualityMode): GovernorMode {
  return bound ?? governorModeOf(quality);
}

let ladders: Record<GovernorMode, readonly LadderStep[]> | null = null;
/** Built on first use, so loading the layout builds no governor machine. */
function ladderOf(mode: GovernorMode): readonly LadderStep[] {
  ladders ??= { default: qualityLadder('default'), beauty: qualityLadder('beauty') };
  return ladders[mode];
}

/** The highest fixed level `mode` has: its ladder's length. */
export function qualityLevelMax(mode: GovernorMode): number {
  return ladderOf(mode).length;
}

/** The level a governor in `mode` applies for `level`: it clamps it to the ladder. */
export function appliedLevel(level: number, mode: GovernorMode): number {
  return Math.min(level, qualityLevelMax(mode));
}

function ladderStepLabel(step: LadderStep): string {
  if (step.step === 'foveation' || step.step === 'foveation-max') return `fov ${step.to}`;
  if (step.step === 'fb-scale') return `fb ${step.to}`;
  return `${step.step.slice(0, -'-density'.length)} ${step.to.toFixed(2)}`;
}

/**
 * The quality level's value text: "Auto", "0 · full", or the level and the step it adds, as in
 * "3 · fov 1" or "7 · far 0.10". Each level also keeps every step below it
 * (`qualityLevelSummary` lists them all).
 */
export function qualityLevelLabel(level: QualityLevel, mode: GovernorMode): string {
  if (level === 'auto') return 'Auto';
  const n = appliedLevel(level, mode);
  const step = ladderOf(mode)[n - 1];
  return step ? `${n} · ${ladderStepLabel(step)}` : `${n} · full`;
}

const LEVERS = ['foveation', 'fb-scale', 'far-density', 'mid-density', 'near-density'] as const;

/**
 * Everything `level` sets, for the hover help: "Auto adapts", "full quality", or each lever it
 * moves at its value, as in "fov 1, fb 0.85, far 0.10, mid 0.63".
 */
export function qualityLevelSummary(level: QualityLevel, mode: GovernorMode): string {
  if (level === 'auto') return 'Auto adapts';
  const applied = ladderOf(mode).slice(0, appliedLevel(level, mode));
  if (applied.length === 0) return 'full quality';
  const last = new Map<string, LadderStep>();
  for (const step of applied)
    last.set(step.step === 'foveation-max' ? 'foveation' : step.step, step);
  return LEVERS.flatMap((lever) => {
    const step = last.get(lever);
    return step ? [ladderStepLabel(step)] : [];
  }).join(', ');
}

/** A slider's definition for this governor mode: the quality level's max follows its ladder. */
export function liveSliderDef(def: ControlDef, mode: GovernorMode): ControlDef {
  return def.field === 'qualityLevel' ? { ...def, max: qualityLevelMax(mode) } : def;
}

/** Where a slider's setting sits on its track, in the slider's units (Auto is `AUTO_SLIDER`). */
export function sliderSetting(def: ControlDef, settings: Settings, mode: GovernorMode): number {
  if (def.field !== 'qualityLevel') return settings[def.field as keyof Settings] as number;
  const level = settings.qualityLevel;
  return level === 'auto' ? AUTO_SLIDER : appliedLevel(level, mode);
}

/**
 * The setting a slider value stores: below 0 on the quality level is Auto. A value at the place
 * the stored level already shows keeps the stored level, so a beauty 18 shown at an adaptive 16
 * is not overwritten by a press that moves nothing.
 */
export function settingFromSlider(
  def: ControlDef,
  value: number,
  settings?: Settings,
  mode?: GovernorMode,
): number | QualityLevel {
  if (def.field !== 'qualityLevel') return value;
  if (value < 0) return 'auto';
  if (settings && mode && sliderSetting(def, settings, mode) === value) {
    return settings.qualityLevel;
  }
  return value;
}

/** `mode` picks the quality level's ladder (`ladderMode`); it defaults to the setting's. */
export function formatValue(
  def: ControlDef,
  settings: Settings,
  mode: GovernorMode = governorModeOf(settings.quality),
): string {
  if (!def.field) return '';
  const value = settings[def.field];
  switch (def.field) {
    case 'qualityLevel':
      return qualityLevelLabel(settings.qualityLevel, mode);
    case 'moveSpeed':
      return `${(value as number).toFixed(1)} m/s`;
    case 'standingHeight':
      return `${(value as number).toFixed(2)} m`;
    case 'vignette':
    case 'calm':
    case 'musicVolume':
    case 'sfxVolume':
      return `${Math.round((value as number) * 100)}%`;
    default:
      return '';
  }
}

/** The option a segmented control shows as active. */
export function activeSegment(def: ControlDef, settings: Settings): number {
  if (!def.field || !def.options) return -1;
  const value = settings[def.field];
  return def.options.findIndex((o) => o.value === value);
}

/** The quality note: a quality change applies at the next XR entry. */
export const QUALITY_NOTE = 'applies on next entry';

export function qualityNote(selected: QualityMode, active: QualityMode): string | null {
  return selected === active ? null : QUALITY_NOTE;
}

/** The help of Return to gallery outside a painting's world, where the button is hidden. */
export const GALLERY_HELP_DISABLED = 'Only inside a painting';

export function lockedHelp(flag: string): string {
  return `Set by ${flag} for this session`;
}
