/**
 * The A/B button (src/diag/ab.ts): a single left-stick click in XR, or V on the desktop, cycles the
 * active group live. The `shimmer` group switches `?zdiag` modes at runtime, every program
 * precompiled, and a full cycle back to base renders the painter view byte-identical to a fresh
 * boot. Both sticks held is recenter, which must not cycle.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

// src/render/strokes/batch.ts and zdiag.ts import the bake outputs, which Playwright cannot load.
/** STROKES_AFTER_BASE. */
const STROKES_AFTER_BASE = 2_000_000;
/** DEFAULT_ORDER_POLICY: the nowrite policy, the default since 2026-11-07. */
const DEFAULT_ORDER_POLICY = {
  base: STROKES_AFTER_BASE,
  reverse: true,
  freeze: false,
  layered: true,
};
/** WRITE_ORDER_POLICY: the old depth-writing default. */
const WRITE_ORDER_POLICY = { base: 0, reverse: false, freeze: false, layered: false };

interface AbDiag {
  group: string;
  variants: string[];
  index: number;
  variant: string;
}

interface ZdiagDiag {
  mode: string | null;
  applied: boolean;
  frozen: boolean;
  precompiled: number;
  precompileMs: number | null;
  state: {
    depthWrite: boolean;
    depthFunc: number;
    alphaToCoverage: boolean;
    alphaTest: boolean;
    sharpGain: number | null;
    order: { base: number; reverse: boolean; freeze: boolean; layered: boolean };
    atlas: { minFilter: number; generateMipmaps: boolean; anisotropy: number };
  } | null;
}

type StrokeState = NonNullable<ZdiagDiag['state']>;

const SHIMMER = ['base', 'write', 'noa2c', 'sharp', 'sharp4', 'freeze'];
const LESS_EQUAL = 3;
const BASE_STATE: StrokeState = {
  depthWrite: false,
  depthFunc: LESS_EQUAL,
  alphaToCoverage: true,
  alphaTest: false,
  sharpGain: null,
  order: DEFAULT_ORDER_POLICY,
  // LinearMipmapLinearFilter with mips, and no anisotropy.
  atlas: { minFilter: 1008, generateMipmaps: true, anisotropy: 1 },
};
/** Each shimmer variant's stroke state, as zdiag reports it. */
const EXPECTED: Record<string, StrokeState> = {
  base: BASE_STATE,
  write: { ...BASE_STATE, depthWrite: true, order: WRITE_ORDER_POLICY },
  nowrite: BASE_STATE,
  noa2c: { ...BASE_STATE, alphaToCoverage: false, alphaTest: true },
  sharp: { ...BASE_STATE, sharpGain: 2 },
  sharp4: { ...BASE_STATE, sharpGain: 4 },
  freeze: BASE_STATE,
};

async function ab(xr: Xr): Promise<AbDiag | null> {
  return (await xr.diag()).ab as AbDiag | null;
}

async function zdiag(xr: Xr): Promise<ZdiagDiag> {
  return (await xr.diag()).zdiag as ZdiagDiag;
}

async function hudText(xr: Xr): Promise<string> {
  return ((await xr.diag()).hud as { text?: string }).text ?? '';
}

function setButton(page: Page, hand: 'left' | 'right', button: string, value: number) {
  return page.evaluate(
    ([h, b, v]) => {
      const controller = window.__goghIwer?.controllers[h];
      if (!controller) throw new Error(`IWER ${h} controller is not available`);
      controller.updateButtonValue(b, v);
    },
    [hand, button, value] as const,
  );
}

async function pressV(page: Page, xr: Xr): Promise<void> {
  // V is read per frame, so it is held across frames rather than tapped.
  await page.keyboard.down('KeyV');
  await xr.waitFrames(2);
  await page.keyboard.up('KeyV');
  await xr.waitFrames(2);
}

async function rawPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
    return window.__goghShot();
  });
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).raw().toBuffer();
}

async function bootStrokes(xr: Xr, query: string): Promise<void> {
  await xr.boot(`strokesTest&nogov&${query}`);
  await expect.poll(async () => (await zdiag(xr)).state !== null, { timeout: 30_000 }).toBe(true);
}

test('a boot with no A/B flag builds no group', async ({ xr }) => {
  await bootStrokes(xr, 'hud');
  expect(await ab(xr)).toBeNull();
  expect(await zdiag(xr)).toMatchObject({ mode: null, applied: false, precompiled: 0 });
  await xr.waitFrames(5);
  expect(await hudText(xr)).not.toContain('A/B');
});

test('the no-flag gallery boot builds no group and no HUD', async ({ xr }) => {
  await xr.boot();
  await expect.poll(async () => (await zdiag(xr)).state !== null, { timeout: 60_000 }).toBe(true);
  await xr.waitFrames(5);
  expect(await ab(xr)).toBeNull();
  expect((await xr.diag()).abSwitch).toBeNull();
  expect(await zdiag(xr)).toMatchObject({ mode: null, applied: false, precompiled: 0 });
  expect((await xr.diag()).hud).toEqual({ visible: false, built: false });
});

test('?ab=halo on a world without a halo pass warns once', async ({ page, xr }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().startsWith('A/B halo')) {
      warnings.push(message.text());
    }
  });
  await xr.boot('ab=halo');
  await expect.poll(async () => (await zdiag(xr)).state !== null, { timeout: 60_000 }).toBe(true);
  await xr.waitFrames(5);
  expect(warnings).toEqual([
    'A/B halo: world gallery has no halo pass, so the halo group does nothing',
  ]);
  expect(await ab(xr)).toMatchObject({ group: 'halo', index: 0 });
});

test('in XR the left stick click cycles shimmer, each mode applies and no switch links a program', async ({
  page,
  xr,
}) => {
  // No `?hud`: an active group builds and shows the HUD at boot, so its programs are counted below.
  await bootStrokes(xr, 'ab=shimmer');
  await expect
    .poll(async () => (await xr.diag()).hud)
    .toMatchObject({ visible: true, built: true, typeset: true });
  await expect.poll(() => hudText(xr)).toContain('A/B shimmer: base (1/6)');
  await xr.enterXR();
  const start = await zdiag(xr);
  expect(start.precompiled).toBe(4);
  expect(await ab(xr)).toEqual({ group: 'shimmer', variants: SHIMMER, index: 0, variant: 'base' });
  expect(start.state).toEqual(BASE_STATE);
  await xr.waitFrames(5);
  const programs = (await xr.diag()).renderer.programs;

  for (let step = 1; step <= SHIMMER.length; step += 1) {
    const index = step % SHIMMER.length;
    const variant = SHIMMER[index];
    await xr.press('left', 'thumbstick');
    expect(await ab(xr), variant).toMatchObject({ index, variant });
    const z = await zdiag(xr);
    expect(z.mode, variant).toBe(variant === 'base' ? null : variant);
    expect(z.state, variant).toEqual(EXPECTED[variant]);
    // freeze locks the eye poses on its first XR frame, and leaving it drops them.
    expect(z.frozen, variant).toBe(variant === 'freeze');
    await expect
      .poll(() => hudText(xr), { message: variant })
      .toContain(`A/B shimmer: ${variant} (${index + 1}/${SHIMMER.length})`);
    await xr.waitFrames(3);
    expect((await xr.diag()).renderer.programs, `${variant} linked no new program`).toBe(programs);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('in XR both sticks held recenters without cycling', async ({ page, xr }) => {
  await bootStrokes(xr, 'ab=shimmer');
  await xr.enterXR();
  // Counts every frame's recenter and abCycle edges.
  await page.evaluate(() => {
    const seen = { recenter: 0, abCycle: 0 };
    (window as unknown as { __abSeen: typeof seen }).__abSeen = seen;
    const tick = (): void => {
      const actions = (window.__goghDiag?.() as { input?: { actions?: Record<string, unknown> } })
        ?.input?.actions;
      if (actions?.recenter) seen.recenter += 1;
      if (actions?.abCycle) seen.abCycle += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const seen = () =>
    page.evaluate(
      () => (window as unknown as { __abSeen: { recenter: number; abCycle: number } }).__abSeen,
    );

  // Snap-turn first, so the recenter has a turn to undo.
  const yaw = async () => ((await xr.diag()).rig as { yaw: number }).yaw;
  await xr.stick('right', 1, 0);
  await xr.stick('right', 0, 0);
  const turned = await yaw();
  expect(Math.abs(turned)).toBeGreaterThan(0.1);

  await setButton(page, 'left', 'thumbstick', 1);
  await xr.waitFrames(2);
  await setButton(page, 'right', 'thumbstick', 1);
  await expect.poll(async () => (await seen()).recenter, { timeout: 5_000 }).toBeGreaterThan(0);
  // The recenter faces the spawn yaw (0 here) again.
  await expect.poll(async () => Math.abs(await yaw())).toBeLessThan(1e-6);
  await setButton(page, 'right', 'thumbstick', 0);
  await xr.waitFrames(2);
  await setButton(page, 'left', 'thumbstick', 0);
  await xr.waitFrames(5);
  expect(await seen()).toMatchObject({ abCycle: 0 });
  expect(await ab(xr)).toMatchObject({ index: 0, variant: 'base' });

  // A single click afterwards still cycles.
  await xr.press('left', 'thumbstick');
  expect(await ab(xr)).toMatchObject({ index: 1, variant: 'write' });
  expect(await glErrors(page)).toEqual([]);
});

test('?nohalo alone starts the halo group at off without showing the HUD until the first switch', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&nohalo');
  await expect
    .poll(async () => (await xr.diag()).halo !== undefined, { timeout: 90_000 })
    .toBe(true);
  expect(await ab(xr)).toMatchObject({ group: 'halo', index: 1, variant: 'off' });
  await xr.waitFrames(5);
  // An implied group keeps the HUD out of the captures that ?nohalo drives.
  expect((await xr.diag()).hud).toEqual({ visible: false, built: false });
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 0, variant: 'on' });
  await expect
    .poll(async () => (await xr.diag()).hud)
    .toMatchObject({
      visible: true,
      built: true,
      text: expect.stringContaining('A/B halo: on (1/2)'),
    });
  expect(await glErrors(page)).toEqual([]);
});

test('?ab=halo&nohalo starts the halo group at off, and V turns the pass on and off live', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&ab=halo&nohalo');
  await expect
    .poll(async () => (await xr.diag()).halo !== undefined, { timeout: 90_000 })
    .toBe(true);
  await expect
    .poll(async () => (await xr.diag()).hud)
    .toMatchObject({ built: true, typeset: true });
  const halo = async () => ((await xr.diag()).halo as { visible: boolean }).visible;
  expect(await ab(xr)).toEqual({
    group: 'halo',
    variants: ['on', 'off'],
    index: 1,
    variant: 'off',
  });
  expect(await halo()).toBe(false);
  await xr.waitFrames(3);
  const programs = (await xr.diag()).renderer.programs;
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 0, variant: 'on' });
  expect(await halo()).toBe(true);
  await xr.waitFrames(3);
  // The world build precompiled the hidden halo, so showing it links nothing.
  expect((await xr.diag()).renderer.programs).toBe(programs);
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 1, variant: 'off' });
  expect(await halo()).toBe(false);
  expect(await glErrors(page)).toEqual([]);
});

test('?ab=calm cycles the motion calm through 1, 0.5 and 0.25', async ({ page, xr }) => {
  await xr.boot('demo=canvas&ab=calm&calm=0.5');
  const calm = async () => ((await xr.diag()).motion as { calm: number }).calm;
  await expect.poll(async () => (await ab(xr))?.variant).toBe('0.5');
  expect(await calm()).toBe(0.5);
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 2, variant: '0.25' });
  expect(await calm()).toBe(0.25);
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 0, variant: '1' });
  expect(await calm()).toBe(1);
  expect(await glErrors(page)).toEqual([]);
});

test('?ab=calm starts at the stored calm, not at 1', async ({ page, xr }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'gogh-xr.settings.v1',
      JSON.stringify({ version: 1, settings: { calm: 0.25 } }),
    );
  });
  await xr.boot('demo=canvas&ab=calm');
  await expect.poll(async () => (await ab(xr))?.variant).toBe('0.25');
  expect(((await xr.diag()).motion as { calm: number }).calm).toBe(0.25);
});

test('?ab=calm inserts a stored calm that is no variant and starts there, so the boot keeps it (F1)', async ({
  page,
  xr,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'gogh-xr.settings.v1',
      JSON.stringify({ version: 1, settings: { calm: 0.7 } }),
    );
  });
  await xr.boot('demo=canvas&ab=calm');
  await expect.poll(async () => (await ab(xr))?.variant).toBe('0.7');
  expect(await ab(xr)).toMatchObject({ variants: ['1', '0.7', '0.5', '0.25'], index: 1 });
  expect(((await xr.diag()).motion as { calm: number }).calm).toBe(0.7);
  await pressV(page, xr);
  expect(await ab(xr)).toMatchObject({ index: 2, variant: '0.5' });
  expect(((await xr.diag()).motion as { calm: number }).calm).toBe(0.5);
});

test.describe('the painter view', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  for (const group of ['shimmer', 'zdiag-all'] as const) {
    test(`V cycles ${group} on the desktop, and a full cycle back to base matches a fresh boot byte for byte`, async ({
      page,
      xr,
    }) => {
      test.setTimeout(240_000);
      const query = 'painting=starry-night&noanim&seed=1&shot&painter';
      const bootWorld = async (extra: string): Promise<void> => {
        await xr.boot(`${query}${extra}`);
        await expect
          .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
          .toBe(true);
        await expect.poll(async () => (await zdiag(xr)).state !== null).toBe(true);
        // Let the batch cull and band after the build, as scripts/capture-shot.ts does.
        await xr.waitFrames(5);
      };
      const hideHud = async (): Promise<void> => {
        await page.keyboard.press('h');
        await expect
          .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
          .toBe(false);
        await xr.waitFrames(5);
      };

      await bootWorld('');
      const fresh = await rawPixels(page);

      await bootWorld(`&ab=${group}`);
      const variants = ((await ab(xr)) as AbDiag).variants;
      const z = await zdiag(xr);
      console.log(
        `[e2e] ab ${group} precompile: ${z.precompiled} programs in ${z.precompileMs?.toFixed(2)} ms`,
      );
      const timings: string[] = [];
      for (let step = 1; step <= variants.length; step += 1) {
        const index = step % variants.length;
        const variant = variants[index];
        await pressV(page, xr);
        expect(await ab(xr), variant).toMatchObject({ index, variant });
        const state = await zdiag(xr);
        expect(state.mode, variant).toBe(variant === 'base' ? null : variant);
        if (EXPECTED[variant]) expect(state.state, variant).toEqual(EXPECTED[variant]);
        const sw = (await xr.diag()).abSwitch as {
          variant: string;
          applyMs: number;
          frameMs: number | null;
        };
        expect(sw.variant).toBe(variant);
        if (variant === 'noa2c') {
          // Negative control: a live variant renders differently, so the final match means
          // something. The HUD sits below the painter frame's centre, so hide it first.
          await hideHud();
          expect((await rawPixels(page)).equals(fresh), 'noa2c differs from base').toBe(false);
        }
        timings.push(
          `${variant} apply ${sw.applyMs.toFixed(2)} ms, frame ${sw.frameMs?.toFixed(2)} ms`,
        );
      }
      console.log(`[e2e] ab ${group} desktop switches: ${timings.join('; ')}`);
      // Each switch shows the HUD; hide it for the capture.
      await expect
        .poll(async () => (await xr.diag()).hud)
        .toMatchObject({ visible: true, built: true });
      await hideHud();
      const cycled = await rawPixels(page);
      expect(cycled.length).toBe(fresh.length);
      expect(cycled.equals(fresh), 'a full cycle back to base renders a fresh boot').toBe(true);
      expect(await glErrors(page)).toEqual([]);
    });
  }
  // The wrap variants (src/motion/variants.ts) only show while the motion runs, so this boots with
  // a pinned ?motiont rather than ?noanim, where every variant draws the rest pose.
  test('V cycles wrap live at a pinned motion time, each variant reports and draws its own wrap, and a full cycle back to base matches a fresh boot byte for byte', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    const query = 'painting=starry-night&seed=1&shot&painter&nogov&motiont=3.7';
    const bootWorld = async (extra: string): Promise<void> => {
      await xr.boot(`${query}${extra}`);
      await expect
        .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
        .toBe(true);
      await xr.waitFrames(5);
    };
    const hideHud = async (): Promise<void> => {
      if (!((await xr.diag()).hud as { visible: boolean }).visible) return;
      await page.keyboard.press('h');
      await expect
        .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
        .toBe(false);
      await xr.waitFrames(5);
    };
    interface WrapDiag {
      wrap: string;
      drawn: number;
      small: number;
      fading: number;
      hidden: number;
      returning: number;
    }
    const diag = async () => {
      const d = await xr.diag();
      return {
        variants: d.variants as { wrap: string },
        wrap: d.wrap as WrapDiag | undefined,
        programs: d.renderer.programs,
      };
    };

    await bootWorld('');
    const plain = await diag();
    expect(plain.variants).toEqual({ wrap: 'base' });
    // With no wrap group or ?wrap, the wrap diag key is not registered.
    expect(plain.wrap).toBeUndefined();
    const fresh = await rawPixels(page);

    await bootWorld('&ab=wrap');
    const variants = ((await ab(xr)) as AbDiag).variants;
    expect(variants).toEqual(['base', 'opacity', 'pingpong']);
    await hideHud();
    expect((await rawPixels(page)).equals(fresh), 'wrap base matches a fresh boot').toBe(true);
    const programs = (await diag()).programs;
    const timings: string[] = [];
    const reports: string[] = [];
    for (let step = 0; step <= variants.length; step += 1) {
      const index = step % variants.length;
      const variant = variants[index];
      if (step > 0) {
        await pressV(page, xr);
        expect(await ab(xr), variant).toMatchObject({ index, variant });
        const sw = (await xr.diag()).abSwitch as { variant: string; applyMs: number };
        expect(sw.variant).toBe(variant);
        timings.push(`${variant} apply ${sw.applyMs.toFixed(2)} ms`);
      }
      const now = await diag();
      expect(now.variants.wrap, variant).toBe(variant);
      // A switch links no program.
      expect(now.programs, variant).toBe(programs);
      const w = now.wrap as WrapDiag;
      expect(w.wrap, variant).toBe(variant);
      expect(w.drawn, variant).toBeGreaterThan(1000);
      reports.push(`${variant} ${JSON.stringify(w)}`);
      if (variant === 'base') {
        // Base shrinks its wrapping strokes and never fades or turns back.
        expect(w.small).toBeGreaterThan(0);
        expect([w.fading, w.hidden, w.returning]).toEqual([0, 0, 0]);
      } else if (variant === 'opacity') {
        // Full size, with the wrapping strokes fading and the ones at the jump hidden.
        expect(w.small).toBe(0);
        expect(w.fading).toBeGreaterThan(w.hidden);
        expect(w.hidden).toBeGreaterThan(0);
        expect(w.returning).toBe(0);
      } else {
        // Full size and full alpha, with about half the strokes on their way back.
        expect([w.small, w.fading, w.hidden]).toEqual([0, 0, 0]);
        expect(w.returning / w.drawn).toBeGreaterThan(0.4);
        expect(w.returning / w.drawn).toBeLessThan(0.6);
      }
      if (variant !== 'base') {
        await hideHud();
        expect(
          (await rawPixels(page)).equals(fresh),
          `wrap ${variant} moves the sky differently from base`,
        ).toBe(false);
      }
    }
    console.log(`[e2e] ab wrap diag: ${reports.join('; ')}`);
    console.log(`[e2e] ab wrap desktop switches: ${timings.join('; ')}`);
    await hideHud();
    const cycled = await rawPixels(page);
    expect(cycled.equals(fresh), 'a full cycle back to base renders a fresh boot').toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });

  // The `wrap` diag is the TS mirror, so these check the GPU's own wrap formulas in motion.glsl.
  // ?motionphase=0 gives every stroke phase 0, so f = t / 8, and ?motionlayers=sky stills every
  // other motion, so two frames at different pinned times differ only in the sky. At each pair the
  // two variants compute the same tau, size and alpha exactly in float:
  // - opacity at f = 0.5 and base at f = 0.5: tau 0, full size, alpha 1.
  // - pingpong at f = 0.25 and base at f = 0.5: smoothstep(0, 1, 0.5) = 0.5, so tau 0.
  // - pingpong at f = 0.125 and opacity at f = 0.15625: smoothstep(0, 1, 0.25) = 0.15625, so both
  //   have tau −2.75 s on base's arc, at full size and alpha 1.
  // And opacity at f = 0 has alpha 0, so under ?coverage its sky strokes leave the dome bare.
  test('at fixed phases the GPU draws each wrap variant as motion.glsl computes it', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    const query =
      'painting=starry-night&seed=1&shot&painter&nogov&motionlayers=sky&motionphase=0&motiont=4&ab=wrap';
    const bootWorld = async (extra: string): Promise<void> => {
      await xr.boot(`${query}${extra}`);
      await expect
        .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
        .toBe(true);
      await xr.waitFrames(5);
    };
    const hideHud = async (): Promise<void> => {
      if (!((await xr.diag()).hud as { visible: boolean }).visible) return;
      await page.keyboard.press('h');
      await expect
        .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
        .toBe(false);
      await xr.waitFrames(5);
    };
    const cycleTo = async (variant: string): Promise<void> => {
      await pressV(page, xr);
      expect((await ab(xr))?.variant).toBe(variant);
      await hideHud();
    };
    const at = async (time: number): Promise<Buffer> => {
      await page.evaluate((t) => {
        if (!window.__goghMotionT) throw new Error('__goghMotionT is e2e-only and needs ?motiont');
        window.__goghMotionT(t);
      }, time);
      await xr.waitFrames(3);
      return rawPixels(page);
    };
    const wrapDiag = async () =>
      (await xr.diag()).wrap as { drawn: number; fading: number; hidden: number };
    const pixels = CAPTURE_SIZE.width * CAPTURE_SIZE.height;
    /** The `?coverage` sweep's binary bare share (tests/e2e/world-coverage.spec.ts). */
    const bareShare = (frame: Buffer): number => {
      const channels = frame.length / pixels;
      expect([3, 4]).toContain(channels);
      let bare = 0;
      for (let i = 0; i < frame.length; i += channels) {
        if (frame[i] > 192 && frame[i + 1] < 64 && frame[i + 2] > 192) bare++;
      }
      return bare / pixels;
    };

    await bootWorld('');
    await hideHud();
    const base4 = await at(4);
    await cycleTo('opacity');
    expect((await at(4)).equals(base4), 'opacity at f = 0.5 draws as base').toBe(true);
    const opacity125 = await at(1.25);
    // Negative control: the pinned time moves the sky, so the matches below mean something.
    expect(opacity125.equals(base4), 'opacity at f = 0.15625 is off base f = 0.5').toBe(false);
    await cycleTo('pingpong');
    expect((await at(2)).equals(base4), 'pingpong at f = 0.25 draws as base at f = 0.5').toBe(true);
    expect((await at(1)).equals(opacity125), 'pingpong at f = 0.125 draws as opacity').toBe(true);
    expect(await glErrors(page)).toEqual([]);

    await bootWorld('&coverage');
    await hideHud();
    const restBare = bareShare(await at(4));
    await cycleTo('opacity');
    const jumpBare = bareShare(await at(0));
    // The diag follows the pinned phase: every sky stroke is at its jump.
    const jump = await wrapDiag();
    expect(jump.drawn).toBeGreaterThan(1000);
    expect([jump.fading, jump.hidden]).toEqual([jump.drawn, jump.drawn]);
    const backBare = bareShare(await at(4));
    console.log(
      `[e2e] wrap fixed phase coverage: base f 0.5 ${(restBare * 100).toFixed(3)}%, opacity f 0 ${(jumpBare * 100).toFixed(3)}%, opacity f 0.5 ${(backBare * 100).toFixed(3)}%`,
    );
    expect(restBare).toBeLessThan(0.005);
    // At alpha 0 the sky strokes write nothing, so the magenta dome shows over most of the sky.
    expect(jumpBare).toBeGreaterThan(0.25);
    expect(backBare).toBe(restBare);
    expect(await glErrors(page)).toEqual([]);
  });
});
