/** The DOM panel follows a world switch while it is open (P5.5 review F14). */
import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { onGalleryReturnChange, registerGalleryReturn } from '../src/ui/panel-toggle.ts';
import { createSettingsDom } from '../src/ui/settings-dom.ts';

test('an open DOM panel shows and hides Return to gallery as the world switches', () => {
  const store = createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags: { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null },
    save: () => true,
    schedule: () => 0,
    cancel: () => {},
  });
  let callback: (() => void) | null = null;
  const dom = createSettingsDom({
    store,
    recenter: () => {},
    gallery: () => callback,
    onGalleryChange: onGalleryReturnChange,
    sessionQuality: () => 'adaptive-72',
    hud: { visible: () => false, setVisible: () => {} },
    onClose: () => {},
  });
  try {
    dom.setOpen(true);
    const button = dom.element.querySelector<HTMLButtonElement>('[data-control="gallery"]');
    if (!button) throw new Error('no Return to gallery button');
    expect(button.hidden).toBe(true);
    callback = () => {};
    registerGalleryReturn(callback);
    expect(button.hidden).toBe(false);
    callback = null;
    registerGalleryReturn(null);
    expect(button.hidden).toBe(true);
  } finally {
    dom.dispose();
    registerGalleryReturn(null);
  }
});
