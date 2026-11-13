/**
 * The lit window panes under the governor's density sheds (card: face-clamped lattice placement
 * and panes under density sheds, review finding N3).
 *
 * Under the default `area` law a density shed grows the band's survivors by sqrt(from / to). A
 * face-clamped pane stroke already sits at its face's size cap (FACE_SIZE_SHARE), so the shader's
 * fit cap holds it there, and the shed may reopen the far-pane rim and corner loss that the cap
 * fixed (docs/verification.md, Window pane coverage). Levels 4 and up shed the far band.
 *
 * The panes are the first window of each of the 15 seed-1 houses facing the painter
 * (tests/pane-poses.ts), with every motion layer closed (`?coverage&motionlayers=`) and the bands
 * of the fixed quality ladder (`createGovernor({ fixedLevel })`) set through `__goghBands` with
 * the governor off, at levels 0, 4, 5 (the default), 8, 13 and 16.
 *
 * - Far poses (the card's risk): for the 11 panes that have one, the eye stands where the pane's
 *   overlay chunk is in the far band and the whole pane is in sight (both checked in
 *   tests/world-starry-night.test.ts), at 3200 × 1800. The bare share is counted inside the pane's
 *   own projected quad, inset by 1 px. A pane under MIN_PANE_PX on screen is skipped and logged.
 *   Asserted at 0.5% at levels 0 (control) and 4.
 * - Near poses: 0.3 m out, the pane 0.27 m above the eye, as the R-P4o guard stands, at 1280 ×
 *   720, the whole frame counted. Asserted at 0.5% at every tested level, including 13 and 16,
 *   which shed the near band.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { createGovernor } from '../../src/render/governor.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

/** Most bare share allowed on a pane at an asserted level (P2-A3's bar). */
const MAX_BARE = 0.005;
const QUERY = 'painting=starry-night&seed=1&shot&coverage&nogov&motionlayers=';
const LEVELS = [0, 4, 5, 8, 13, 16] as const;
const ASSERTED_FAR = new Set<number>([0, 4]);
const NEAR_VIEW = { width: 1280, height: 720 };

interface PanePose {
  eye: [number, number, number];
  yaw: number;
  pitch: number;
}
interface FixturePane {
  house: number;
  near: PanePose;
  far: PanePose | null;
  farQuad: [number, number][] | null;
  farAreaPx: number;
}
/**
 * The poses come from tests/fixtures/pane-poses.json, computed by tests/pane-poses.ts and checked
 * against it by tests/pane-poses-fixture.test.ts: Playwright cannot import the world modules.
 */
const FIXTURE = JSON.parse(readFileSync('tests/fixtures/pane-poses.json', 'utf8')) as {
  probeView: { width: number; height: number };
  minPanePx: number;
  panes: FixturePane[];
};
const PROBE_VIEW = FIXTURE.probeView;
const MIN_PANE_PX = FIXTURE.minPanePx;
const PANES = FIXTURE.panes;
const FAR = PANES.flatMap((pane) =>
  pane.far ? [{ pane, pose: pane.far, quad: pane.farQuad, area: pane.farAreaPx }] : [],
);

/**
 * Bare share of mostly magenta pixels (the world-coverage.spec.ts count), over the frame, or with
 * `quad` over the pixels whose centres lie inside it at least `inset` px from every edge. Returns
 * the share and the pixels judged.
 */
function bareShare(
  page: Page,
  quad: [number, number][] | null,
  inset: number,
): Promise<{ bare: number; pixels: number }> {
  return page.evaluate(
    ([poly, pad]) => {
      const gl = document.querySelector('canvas') as HTMLCanvasElement;
      const copy = document.createElement('canvas');
      copy.width = gl.width;
      copy.height = gl.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas context is not available');
      context.drawImage(gl, 0, 0);
      const { data } = context.getImageData(0, 0, copy.width, copy.height);
      const magenta = (i: number) => data[i] > 192 && data[i + 1] < 64 && data[i + 2] > 192;
      let bare = 0;
      let pixels = 0;
      if (!poly) {
        for (let i = 0; i < data.length; i += 4) if (magenta(i)) bare++;
        return { bare: bare / (data.length / 4), pixels: data.length / 4 };
      }
      // Signed edge distances: inside when every one is at least `pad` on the polygon's side.
      let area = 0;
      for (let k = 0; k < poly.length; k++) {
        const [x0, y0] = poly[k];
        const [x1, y1] = poly[(k + 1) % poly.length];
        area += x0 * y1 - x1 * y0;
      }
      const side = Math.sign(area);
      const xs = poly.map((p) => p[0]);
      const ys = poly.map((p) => p[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs)));
      const x1 = Math.min(copy.width - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys)));
      const y1 = Math.min(copy.height - 1, Math.ceil(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          let inside = true;
          for (let k = 0; k < poly.length && inside; k++) {
            const [ax, ay] = poly[k];
            const [bx, by] = poly[(k + 1) % poly.length];
            const len = Math.hypot(bx - ax, by - ay);
            const d = (side * ((bx - ax) * (py - ay) - (by - ay) * (px - ax))) / len;
            if (d < pad) inside = false;
          }
          if (!inside) continue;
          pixels++;
          if (magenta((y * copy.width + x) * 4)) bare++;
        }
      }
      return { bare: pixels > 0 ? bare / pixels : 0, pixels };
    },
    [quad, inset] as const,
  );
}

async function setLevel(page: Page, xr: Xr, level: number): Promise<void> {
  const levels = createGovernor({ mode: 'default', targetHz: 72, fixedLevel: level }).levels;
  console.log(`[e2e] panes level ${level}: ${JSON.stringify(levels)}`);
  await page.evaluate(
    (l) => {
      if (!window.__goghBands) throw new Error('__goghBands is e2e-only');
      window.__goghBands(l);
    },
    { density: levels.density, size: levels.size },
  );
  await xr.waitFrames(3);
}

async function visit(page: Page, xr: Xr, { eye, yaw, pitch }: PanePose): Promise<void> {
  await page.evaluate(
    ([x, y, z, h, p]) => {
      if (!window.__goghPose) throw new Error('__goghPose is not installed; boot with ?diag');
      window.__goghPose(x, y, z, h, p);
    },
    [...eye, yaw, pitch] as const,
  );
  await xr.waitFrames(3);
  const camera = (await xr.diag()).camera as { position: number[] };
  const off = Math.hypot(...camera.position.map((v, k) => v - eye[k]));
  expect(off, 'the camera stands at the pose').toBeLessThan(0.01);
}

async function boot(xr: Xr): Promise<void> {
  await xr.boot(QUERY);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(5);
}

test.describe('window panes under density sheds', () => {
  test.describe.configure({ timeout: 900_000 });

  test('every far pane stays covered inside its own quad at levels 0 and 4', async ({
    page,
    xr,
  }) => {
    expect(PANES).toHaveLength(15);
    expect(FAR.map((f) => f.pane.house)).toEqual([4, 5, 7, 8, 9, 10, 11, 15, 16, 17, 19]);
    await page.setViewportSize(PROBE_VIEW);
    await boot(xr);
    const size = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(size, 'the probe projects into a canvas of PROBE_VIEW pixels').toEqual(PROBE_VIEW);
    const failures: string[] = [];
    for (const level of LEVELS) {
      await setLevel(page, xr, level);
      let worst = 0;
      let judged = 0;
      for (const { pane, pose, quad, area } of FAR) {
        if (!quad || area < MIN_PANE_PX) {
          console.log(
            `[e2e] panes far level ${level} house ${pane.house}: skipped, ${area.toFixed(0)} px`,
          );
          continue;
        }
        await visit(page, xr, pose);
        const { bare, pixels } = await bareShare(page, quad, 1);
        judged++;
        worst = Math.max(worst, bare);
        const eye = pose.eye.map((v) => v.toFixed(2)).join(', ');
        console.log(
          `[e2e] panes far level ${level} house ${pane.house} eye (${eye}): bare ${(bare * 100).toFixed(3)}% of ${pixels} px`,
        );
        if (ASSERTED_FAR.has(level) && bare > MAX_BARE) {
          failures.push(`level ${level} house ${pane.house}: ${(bare * 100).toFixed(3)}%`);
        }
      }
      const summary = `${judged} judged, worst ${(worst * 100).toFixed(3)}%`;
      console.log(`[e2e] panes far level ${level}: ${summary}`);
      test.info().annotations.push({ type: `panes far level ${level}`, description: summary });
    }
    expect(failures, `far panes over ${MAX_BARE * 100}% bare`).toEqual([]);
    expect(await glErrors(page)).toEqual([]);
  });

  test('every near pane stays covered at 0.3 m through level 16', async ({ page, xr }) => {
    expect(PANES).toHaveLength(15);
    await page.setViewportSize(NEAR_VIEW);
    await boot(xr);
    const failures: string[] = [];
    for (const level of LEVELS) {
      await setLevel(page, xr, level);
      let worst = 0;
      for (const pane of PANES) {
        await visit(page, xr, pane.near);
        const { bare } = await bareShare(page, null, 0);
        worst = Math.max(worst, bare);
        console.log(
          `[e2e] panes near level ${level} house ${pane.house}: bare ${(bare * 100).toFixed(3)}%`,
        );
        if (bare > MAX_BARE) {
          failures.push(`level ${level} house ${pane.house}: ${(bare * 100).toFixed(3)}%`);
        }
      }
      const summary = `worst ${(worst * 100).toFixed(3)}%`;
      console.log(`[e2e] panes near level ${level}: ${summary}`);
      test.info().annotations.push({ type: `panes near level ${level}`, description: summary });
    }
    expect(failures, `near panes over ${MAX_BARE * 100}% bare`).toEqual([]);
    expect(await glErrors(page)).toEqual([]);
  });
});
