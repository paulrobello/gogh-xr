/**
 * Flight near the cap (draw-call cut review F1): flying out 40 m above the ground toward the
 * nearest dome cell flight can reach, the first sky band crossing moves that 24 m cell alone to the
 * mid band, not its whole 36° sector, and the frame stays inside the default stroke budget.
 *
 * The two eye poses are 5 cm apart along the flight, at radius 51.05 and 51.1 m on the bearing of
 * the dome cell `strokes--4_3_0-dome` at seed 1, each 40 m over the ground and looking at that
 * cell. The unit sweep in tests/world-starry-night.test.ts found them. With the unmitigated sector
 * merge the crossing moved 8,487 drawn strokes to the mid band, and 49% of the pixels changed by
 * more than 32 levels, against 1,134 strokes and 13% on 670342c and on this build.
 */
import { STROKE_BUDGET } from '../../src/render/strokes/bands.ts';
import { expect, glErrors, test } from './fixtures';

interface BandStats {
  readonly chunks: number;
  readonly visible: number;
}
interface WorldStrokes {
  readonly visible: number;
  readonly visibleChunks: number;
  readonly bands: Record<'near' | 'mid' | 'far', BandStats>;
}

const BEFORE = [
  -50.537449527018744, 50.769666378286686, 7.215864141182088, 1.712620245258063, 0.7766873971431236,
];
const AFTER = [
  -50.58694751872003, 50.79813547431425, 7.222931588920758, 1.712620245258063, 0.7769987596156043,
];

test('flying toward a dome cell at the cap moves that cell alone to the mid band, within budget', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&nogov&seed=1');
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  const at = async (pose: number[]): Promise<WorldStrokes> => {
    await page.evaluate((p) => {
      if (!window.__goghPose) throw new Error('__goghPose is not installed; boot with ?diag');
      window.__goghPose(p[0], p[1], p[2], p[3], p[4]);
    }, pose);
    await xr.waitFrames(4);
    return ((await xr.diag()).world as { strokes: WorldStrokes }).strokes;
  };
  const before = await at(BEFORE);
  const after = await at(AFTER);
  console.log(
    `[e2e] flight cap crossing before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );
  expect(before.bands.mid.chunks).toBe(0);
  expect(after.bands.mid.chunks).toBe(1);
  // One 24 m dome cell at mid density, about 1.1k strokes. A merged sector moves about 8.5k.
  expect(after.bands.mid.visible).toBeGreaterThan(0);
  expect(after.bands.mid.visible).toBeLessThan(1_500);
  for (const stats of [before, after]) {
    expect(stats.visible).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
  }
  expect(await glErrors(page)).toEqual([]);
});
