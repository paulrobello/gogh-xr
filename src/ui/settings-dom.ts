/**
 * The desktop preview's settings panel (P5.3): DOM controls built from the same `panel-layout.ts`
 * definitions as the XR panel, writing the same settings store, with the same actions (Recenter,
 * Return to gallery). Each setting has this one control on the desktop. `panel-toggle.ts` imports it
 * lazily on the first M press. Opening releases pointer lock; taking pointer lock again closes it.
 */
import type { GovernorMode } from '../render/governor';
import type { HudLive } from '../settings/apply';
import { foveationPin, type Settings } from '../settings/schema';
import type { SettingsStore } from '../settings/store';
import {
  activeSegment,
  CONTROLS,
  type ControlDef,
  formatValue,
  GALLERY_HELP_DISABLED,
  ladderMode,
  liveSliderDef,
  lockedHelp,
  qualityLevelSummary,
  qualityNote,
  settingFromSlider,
  sliderSetting,
} from './panel-layout';
import { PANEL_COLORS } from './settings-panel-colors';

export interface SettingsDomDeps {
  store: SettingsStore;
  recenter(): void;
  gallery(): (() => void) | null;
  /** Calls its listener when `gallery()` changes; returns the unsubscribe. */
  onGalleryChange?(listener: () => void): () => void;
  sessionQuality(): Settings['quality'];
  /** The running governor's mode, or null with none: the quality level row shows its ladder. */
  governorMode?(): GovernorMode | null;
  /** The perf HUD's live visibility: the HUD toggle shows it and sets it with the setting. */
  hud: HudLive;
  /** Called when the panel closes itself (its Close button, or pointer lock taken). */
  onClose(): void;
  doc?: Document;
}

export interface SettingsDom {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  dispose(): void;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const rgb = (c: readonly [number, number, number]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const CSS = `
@font-face { font-family: 'Gogh Noto Sans'; src: url('${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf'); }
#gogh-settings { position: fixed; top: 16px; right: 16px; z-index: 20; width: 360px; max-height: calc(100vh - 32px);
  overflow: auto; box-sizing: border-box; padding: 18px 20px 20px; background: ${hex(PANEL_COLORS.backing)};
  color: ${hex(PANEL_COLORS.label)}; font: 14px/1.35 'Gogh Noto Sans', system-ui, sans-serif;
  border: 2px solid ${rgb(PANEL_COLORS.frame)}; outline: 1px solid ${rgb(PANEL_COLORS.track)}; outline-offset: -7px;
  border-radius: 2px; box-shadow: 0 12px 32px rgb(0 0 0 / 0.45); }
#gogh-settings[hidden] { display: none; }
#gogh-settings ::selection { background: ${rgb(PANEL_COLORS.active)}; color: ${hex(PANEL_COLORS.onActive)}; }
#gogh-settings h2 { margin: 0 0 12px; padding-bottom: 8px; font-size: 20px; font-weight: 400; color: ${hex(PANEL_COLORS.title)};
  border-bottom: 1px solid ${rgb(PANEL_COLORS.track)}; display: flex; justify-content: space-between; align-items: center; }
#gogh-settings h3 { margin: 16px 0 6px; font-size: 14px; font-weight: 400; color: ${hex(PANEL_COLORS.header)}; }
#gogh-settings .row { margin: 0 0 10px; }
#gogh-settings .head { display: flex; justify-content: space-between; gap: 8px; }
#gogh-settings .value { color: ${hex(PANEL_COLORS.value)}; font-variant-numeric: tabular-nums; }
#gogh-settings .value.note { color: ${hex(PANEL_COLORS.note)}; }
#gogh-settings .value.muted, #gogh-settings .row.off label { color: ${hex(PANEL_COLORS.muted)}; }
#gogh-settings input[type=range] { width: 100%; margin: 6px 0 0; accent-color: ${rgb(PANEL_COLORS.active)}; }
#gogh-settings .seg { display: flex; margin-top: 4px; }
#gogh-settings button { flex: 1; min-height: 32px; padding: 4px 8px; font: inherit; cursor: pointer; border-radius: 2px;
  color: ${hex(PANEL_COLORS.label)}; background: transparent; border: 1px solid ${rgb(PANEL_COLORS.idle)}; }
#gogh-settings .seg button + button { border-left: none; }
#gogh-settings button:hover:not(:disabled) { border-color: ${rgb(PANEL_COLORS.hover)}; background: ${rgb(PANEL_COLORS.track)}; }
#gogh-settings button[aria-pressed=true] { background: ${rgb(PANEL_COLORS.active)}; color: ${hex(PANEL_COLORS.onActive)}; border-color: ${rgb(PANEL_COLORS.active)}; }
#gogh-settings button:disabled, #gogh-settings input:disabled { cursor: not-allowed; opacity: 0.55; }
#gogh-settings button:focus-visible, #gogh-settings input:focus-visible { outline: 2px solid ${rgb(PANEL_COLORS.active)}; outline-offset: 2px; }
#gogh-settings .toggle { flex: 0 0 74px; }
#gogh-settings .actions { display: flex; gap: 10px; margin-top: 18px; }
#gogh-settings .close { flex: 0 0 auto; min-height: 28px; border-color: transparent; color: ${hex(PANEL_COLORS.value)}; }
`;

export function createSettingsDom(deps: SettingsDomDeps): SettingsDom {
  const doc = deps.doc ?? document;
  const { store } = deps;
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  const panel = doc.createElement('section');
  panel.id = 'gogh-settings';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Settings');
  const title = doc.createElement('h2');
  title.textContent = 'Settings';
  const close = doc.createElement('button');
  close.className = 'close';
  close.textContent = 'Close';
  close.title = 'Close settings (M)';
  close.addEventListener('click', () => {
    setOpen(false);
    deps.onClose();
  });
  title.appendChild(close);
  panel.appendChild(title);

  const updaters: (() => void)[] = [];

  function levelMode(): GovernorMode {
    return ladderMode(deps.governorMode?.() ?? null, store.effective.quality);
  }

  function helpFor(def: ControlDef): string {
    const flag = def.field ? store.locks[def.field] : undefined;
    if (flag) return lockedHelp(flag);
    if (def.action === 'gallery' && deps.gallery() === null) return GALLERY_HELP_DISABLED;
    return def.disabled ?? def.help;
  }

  function row(def: ControlDef): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'row';
    el.dataset.control = def.id;
    const head = doc.createElement('div');
    head.className = 'head';
    const label = doc.createElement('label');
    label.textContent = def.label;
    const value = doc.createElement('span');
    value.className = 'value';
    head.append(label, value);
    el.appendChild(head);
    const field = def.field as keyof Settings;
    const locked = store.locks[field];
    const off = Boolean(def.disabled || locked);
    el.title = helpFor(def);
    if (off) el.classList.add('off');
    const setValue = (): void => {
      value.className = 'value';
      value.textContent = formatValue(def, store.effective, levelMode());
      if (locked) {
        value.textContent = `set by ${locked.split('=')[0]}`;
        value.classList.add('muted');
      } else if (def.disabled) {
        value.textContent = 'later';
        value.classList.add('muted');
      } else if (field === 'quality') {
        const note = qualityNote(store.effective.quality, deps.sessionQuality());
        if (note) {
          value.textContent = note;
          value.classList.add('note');
        }
      }
    };
    if (def.kind === 'slider') {
      const input = doc.createElement('input');
      input.type = 'range';
      input.min = String(def.min ?? 0);
      input.max = String(def.max ?? 1);
      input.step = String(def.step ?? 0.01);
      input.disabled = off;
      input.setAttribute('aria-label', def.label);
      input.addEventListener('input', () =>
        store.set(
          field,
          settingFromSlider(def, Number(input.value), store.effective, levelMode()) as never,
        ),
      );
      input.addEventListener('change', () => store.commit());
      el.appendChild(input);
      updaters.push(() => {
        const mode = levelMode();
        input.max = String(liveSliderDef(def, mode).max ?? 1);
        input.value = String(sliderSetting(def, store.effective, mode));
        setValue();
        input.setAttribute('aria-valuetext', value.textContent ?? '');
        if (field === 'qualityLevel' && !off) {
          el.title = `${helpFor(def)}. Now: ${qualityLevelSummary(store.effective.qualityLevel, mode, foveationPin(store.effective))}`;
        }
      });
    } else {
      const seg = doc.createElement('div');
      seg.className = 'seg';
      const options = def.kind === 'toggle' ? [{ value: true, label: 'On' }] : (def.options ?? []);
      const buttons = options.map((option) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = option.label;
        b.disabled = off;
        if (def.kind === 'toggle') b.className = 'toggle';
        b.addEventListener('click', () => {
          if (field === 'hud') {
            // Flips what is showing now, then stores it as the starting visibility.
            const next = !deps.hud.visible();
            store.set('hud', next);
            store.commit();
            deps.hud.setVisible(next);
            refresh();
            return;
          }
          const next = def.kind === 'toggle' ? !store.effective[field] : option.value;
          store.set(field, next as never);
          store.commit();
        });
        seg.appendChild(b);
        return b;
      });
      el.appendChild(seg);
      updaters.push(() => {
        if (def.kind === 'toggle') {
          const on = field === 'hud' ? deps.hud.visible() : store.effective[field] === true;
          const b = buttons[0];
          if (b) {
            b.setAttribute('aria-pressed', String(on));
            b.textContent = on ? 'On' : 'Off';
          }
        } else {
          const active = activeSegment(def, store.effective);
          for (const [i, b] of buttons.entries())
            b.setAttribute('aria-pressed', String(i === active));
        }
        setValue();
      });
    }
    return el;
  }

  for (const [column, heading] of ['Comfort', 'World'].entries()) {
    const h = doc.createElement('h3');
    h.textContent = heading;
    panel.appendChild(h);
    for (const def of CONTROLS) {
      if (def.kind !== 'button' && def.column === column) panel.appendChild(row(def));
    }
  }
  const actions = doc.createElement('div');
  actions.className = 'actions';
  for (const def of CONTROLS) {
    if (def.kind !== 'button') continue;
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = def.label;
    b.dataset.control = def.id;
    b.addEventListener('click', () => {
      if (def.action === 'recenter') deps.recenter();
      else deps.gallery()?.();
    });
    actions.appendChild(b);
    updaters.push(() => {
      b.title = helpFor(def);
      // Return to gallery shows only inside a painting's world (P5.5).
      b.hidden = def.action === 'gallery' && deps.gallery() === null;
      b.disabled = b.hidden;
    });
  }
  panel.appendChild(actions);
  doc.body.appendChild(panel);

  const refresh = (): void => {
    for (const update of updaters) update();
  };
  const unsubscribe = store.subscribe(refresh);
  // A world switch while the panel is open shows or hides Return to gallery at once.
  const unsubscribeGallery = deps.onGalleryChange?.(refresh) ?? (() => {});

  function setOpen(next: boolean): void {
    if (next) {
      refresh();
      if (doc.pointerLockElement) doc.exitPointerLock();
    }
    panel.hidden = !next;
  }

  const onLock = (): void => {
    if (doc.pointerLockElement && !panel.hidden) {
      setOpen(false);
      deps.onClose();
    }
  };
  doc.addEventListener('pointerlockchange', onLock);

  return {
    element: panel,
    get isOpen() {
      return !panel.hidden;
    },
    setOpen,
    dispose() {
      unsubscribe();
      unsubscribeGallery();
      doc.removeEventListener('pointerlockchange', onLock);
      panel.remove();
      style.remove();
    },
  };
}
