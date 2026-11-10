import { test as base, expect, type Page } from '@playwright/test';

export type Hand = 'left' | 'right';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface PoseTarget {
  position?: Vec3;
  quaternion?: Quat;
}

export interface Pose {
  head?: PoseTarget;
  left?: PoseTarget;
  right?: PoseTarget;
}

export interface Diag {
  build: string;
  renderer: { frame: number; programs: number; textures: number; unmaskedRenderer: string | null };
  xr: { supported: boolean | null; presenting: boolean; sessionMode: string | null };
  camera: { position: number[]; quaternion: number[] };
  input?: {
    selectstart: Record<'none' | 'left' | 'right', number>;
    /** The last Actions frame (src/xr/input.ts), null before the first rendered frame. */
    actions: {
      move: { x: number; y: number };
      turn: { x: number; snap: number };
      vertical: number;
      select: { down: boolean; fired: boolean };
      grip: { down: boolean; fired: boolean };
      [key: string]: unknown;
    } | null;
  };
  [key: string]: unknown;
}

export interface Xr {
  /** Loads the app with IWER and diag enabled, plus any extra query flags. */
  boot(extraQuery?: string): Promise<void>;
  enterXR(): Promise<void>;
  /** Presses and releases a controller button, holding it across rendered frames. */
  press(hand: Hand, button: string): Promise<void>;
  stick(hand: Hand, x: number, y: number): Promise<void>;
  setPose(pose: Pose): Promise<void>;
  diag(): Promise<Diag>;
  waitFrames(count: number): Promise<void>;
}

// Chromium reports WebGL errors as console warnings, and three logs shader
// compile/link failures through console.error or console.warn.
const GL_ERROR =
  /GL_INVALID_|WebGL: INVALID_|CONTEXT_LOST|THREE\.WebGL(Program|Shader)|Shader Error/;

/**
 * Stores the Auto quality level and Auto foveation before the page loads. The default is a fixed
 * level, which never judges frames, and a foveation pinned Off, which takes both foveation steps
 * out of the shed order, so a spec of the adaptive governor opts back in to both.
 */
export async function useAutoQuality(page: Page): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem(
      'gogh-xr.settings.v1',
      JSON.stringify({ version: 4, settings: { qualityLevel: 'auto', foveation: 'auto' } }),
    ),
  );
}

/** Drains the GL error queue; the pageErrors fixture separately fails on console GL errors. */
export function glErrors(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) throw new Error('no WebGL2 context on the app canvas');
    const errors: number[] = [];
    for (let e = gl.getError(); e !== gl.NO_ERROR && errors.length < 16; e = gl.getError()) {
      errors.push(e);
    }
    return errors;
  });
}

function readDiag(page: Page): Promise<Diag> {
  return page.evaluate(() => {
    const diag = window.__goghDiag;
    if (!diag) throw new Error('__goghDiag is not installed; boot with ?diag');
    return diag() as unknown as Diag;
  });
}

function createXr(page: Page): Xr {
  const waitFrames = async (count: number): Promise<void> => {
    const start = (await readDiag(page)).renderer.frame;
    await expect
      .poll(async () => (await readDiag(page)).renderer.frame, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(start + count);
  };

  const setButton = (hand: Hand, button: string, value: number): Promise<void> =>
    page.evaluate(
      ([h, b, v]) => {
        const controller = window.__goghIwer?.controllers[h];
        if (!controller) throw new Error(`IWER ${h} controller is not available`);
        controller.updateButtonValue(b, v);
      },
      [hand, button, value] as const,
    );

  return {
    async boot(extraQuery = '') {
      await page.goto(`/?iwer&diag${extraQuery ? `&${extraQuery}` : ''}`);
      await expect
        .poll(() => page.evaluate(() => Boolean(window.__goghIwer && window.__goghDiag)))
        .toBe(true);
    },
    async enterXR() {
      const button = page.locator('#enter-vr');
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(async () => (await readDiag(page)).xr.presenting).toBe(true);
      // The camera still holds the desktop pose until an XR frame renders.
      await waitFrames(2);
    },
    async press(hand, button) {
      await setButton(hand, button, 1);
      await waitFrames(2);
      await setButton(hand, button, 0);
      await waitFrames(2);
    },
    async stick(hand, x, y) {
      await page.evaluate(
        ([h, ax, ay]) => {
          const controller = window.__goghIwer?.controllers[h];
          if (!controller) throw new Error(`IWER ${h} controller is not available`);
          controller.updateAxes('thumbstick', ax, ay);
        },
        [hand, x, y] as const,
      );
      await waitFrames(2);
    },
    async setPose(pose) {
      await page.evaluate((p) => {
        const device = window.__goghIwer;
        if (!device) throw new Error('IWER is not installed; boot with ?iwer');
        const targets = [
          [p.head, device],
          [p.left, device.controllers.left],
          [p.right, device.controllers.right],
        ] as const;
        for (const [target, node] of targets) {
          if (!target) continue;
          if (!node) throw new Error('IWER pose target is not available');
          if (target.position) node.position.set(...target.position);
          if (target.quaternion) node.quaternion.set(...target.quaternion);
        }
      }, pose);
      await waitFrames(2);
    },
    diag: () => readDiag(page),
    waitFrames,
  };
}

/**
 * The `xr` fixture drives the IWER device through page.evaluate. The automatic
 * `pageErrors` fixture fails every test on any console.error, page error,
 * WebGL error or three shader log.
 */
export const test = base.extend<{ xr: Xr; pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        const text = message.text();
        const url = message.location().url;
        // Chromium requests a favicon the app does not ship; nothing else is allowed.
        const path = new URL(url || 'about:blank').pathname;
        if (path === '/favicon.ico') return;
        // A missing /audio/ file 404s on a host without Vite's index.html fallback (Pages), and the
        // mixer then runs that cue silent (P6.5). vite preview answers it with index.html instead.
        if (path.startsWith('/audio/') && text.startsWith('Failed to load resource')) return;
        if (message.type() === 'error' || GL_ERROR.test(text)) {
          errors.push(`console.${message.type()}: ${text}${url ? ` (${url})` : ''}`);
        }
      });
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      await use(errors);
      expect(errors, 'console, page, WebGL or shader errors').toEqual([]);
    },
    { auto: true },
  ],
  xr: async ({ page }, use) => {
    await use(createXr(page));
  },
});

export { expect };
