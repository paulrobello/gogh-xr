/**
 * Roof eave probe: captures one seed-1 house from the ground under its eave, looking up, and from
 * above its roof, looking down, normal and `?coverage`, and measures what the eave's underside
 * shows.
 *
 *   bun scripts/eave-probe.ts <base-url> [--tag after] [--out /tmp/gx-eave] [--json out.json]
 *     [--dry]
 *
 * `--dry` prints the poses and the attributed sample counts without capturing.
 *
 * Captures `?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1` at 1280 × 720 through
 * `__goghPose` in headless Chromium on the GPU. The house is the one nearest the painter's spot
 * whose eave-side wall facing the spot has a clear pose. The ground eye stands 2 m out from that
 * wall's centre, 1.6 m above the ground, facing it, pitched 0.7 rad up. It must sit below the roof
 * plane there, so the near slope and its overhang are seen from below. The raised eye stands 6 m
 * out, 3 m above the ridge, pitched 0.5 rad down.
 *
 * Attribution is geometric, as in scripts/village-contrast.ts: every 4th pixel casts a ray against
 * the village, window, church and cypress meshes, both sides, and marches the terrain. A sample is
 * `soffit` where the nearest hit is a roof triangle seen from below its plane, `roof` where it is
 * the target house's roof seen from above, `sky` where nothing is hit, and is kept only where its
 * four grid neighbours agree. Each soffit sample is called sky-like when its colour is nearer (CIEDE2000) to the frame's
 * mean sky colour than to the mean roof colour of the raised view. `soffitL` and `roofL` are the
 * CIELAB lightness of the soffit samples' mean colour and of the raised view's roof samples'.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { DoubleSide, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2 } from 'three';
import { TINT_ROLE, type TintTags } from '../src/paintings/starry-night/village-tint';
import { createWorldGeometry, worldSeeds } from '../src/paintings/starry-night/world';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { deltaE2000, type Lab, linearToLab, srgbToLinear } from './fidelity-lib.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const tag = option('tag') ?? 'after';
const outDir = option('out') ?? '/tmp/gx-eave';
const jsonPath = option('json');
const dry = args.includes('--dry');
if (dry) args.splice(args.indexOf('--dry'), 1);
const [base] = args;
if (!base) {
  console.error('usage: bun scripts/eave-probe.ts <base-url> [--tag T] [--out DIR] [--json F]');
  process.exit(2);
}

const WIDTH = 1280;
const HEIGHT = 720;
const GRID = 4;
const EYE = 1.6;
const GROUND_OFF = 2;
const GROUND_PITCH = 0.7;
const RAISED_OFF = 6;
const RAISED_ABOVE_RIDGE = 3;
const RAISED_PITCH = -0.5;

const world = createWorldGeometry(worldSeeds(1));
const { village, terrain } = world;
const geos = village.geometries;
const material = new MeshBasicMaterial({ side: DoubleSide });
const targets = [
  { kind: 'building', mesh: new Mesh(geos.building, material) },
  { kind: 'roof', mesh: new Mesh(geos.roof, material) },
  { kind: 'window', mesh: new Mesh(geos.window, material) },
  { kind: 'church', mesh: new Mesh(geos.church, material) },
  { kind: 'cypress', mesh: new Mesh(world.cypress.geometry, material) },
] as const;
for (const t of targets) t.mesh.updateMatrixWorld();

interface Pose {
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
}

/** The eye stands clear of every house and church outline by 0.5 m. */
function standsClear(x: number, z: number): boolean {
  const inside = (poly: readonly (readonly [number, number])[]): boolean => {
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      const ex = bx - ax;
      const ez = bz - az;
      if (((x - ax) * ez - (z - az) * ex) / Math.hypot(ex, ez) > 0.5) return false;
    }
    return true;
  };
  return ![...village.houses.map((h) => h.outline), village.church.outline].some((o) =>
    inside(o as readonly (readonly [number, number])[]),
  );
}

/** The ground and raised poses of the nearest house with a clear eave-side pose. */
function choosePoses(): { house: number; poses: Pose[] } {
  const order = village.houses
    .map((h, i) => ({ i, d: Math.hypot(h.center[0], h.center[2]) }))
    .sort((a, b) => a.d - b.d);
  for (const { i } of order) {
    const h = village.houses[i];
    const c = Math.cos(h.yaw);
    const s = Math.sin(h.yaw);
    // The two long walls are the eave sides (local ±z); take the one facing the spot more.
    const walls = [1, -1].map((side) => {
      const nx = side * s;
      const nz = side * c;
      const cx = h.center[0] + (nx * h.depth) / 2;
      const cz = h.center[2] + (nz * h.depth) / 2;
      return { nx, nz, cx, cz, facing: -(cx * nx + cz * nz) / Math.hypot(cx, cz) };
    });
    const w = walls[0].facing >= walls[1].facing ? walls[0] : walls[1];
    const gx = w.cx + w.nx * GROUND_OFF;
    const gz = w.cz + w.nz * GROUND_OFF;
    const eyeY = terrain.heightAt(gx, gz) + EYE;
    const rise = h.ridgeHeight - h.eaveHeight;
    const roofPlaneY = h.center[1] + h.eaveHeight - (GROUND_OFF * rise) / (h.depth / 2);
    const rx = w.cx + w.nx * RAISED_OFF;
    const rz = w.cz + w.nz * RAISED_OFF;
    if (eyeY >= roofPlaneY - 0.3 || !standsClear(gx, gz) || !standsClear(rx, rz)) continue;
    const yaw = Math.atan2(w.nx, w.nz);
    return {
      house: i,
      poses: [
        { name: 'ground', position: [gx, eyeY, gz], yaw, pitch: GROUND_PITCH },
        {
          name: 'raised',
          position: [rx, h.center[1] + h.ridgeHeight + RAISED_ABOVE_RIDGE, rz],
          yaw,
          pitch: RAISED_PITCH,
        },
      ],
    };
  }
  throw new Error('no house with a clear eave pose');
}

/** Surface key per grid sample: 'soffit', 'roof', 'sky' or another surface's kind. */
function attribute(pose: Pose): string[][] {
  const camera = new PerspectiveCamera(70, WIDTH / HEIGHT, 0.1, 1000);
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pose.pitch, pose.yaw, 0);
  camera.updateMatrixWorld();
  const ray = new Raycaster();
  const ndc = new Vector2();
  const out: string[][] = [];
  for (let r = 0; r < HEIGHT / GRID; r++) {
    const row: string[] = [];
    for (let c = 0; c < WIDTH / GRID; c++) {
      ndc.set(((c * GRID + GRID / 2) / WIDTH) * 2 - 1, 1 - ((r * GRID + GRID / 2) / HEIGHT) * 2);
      ray.setFromCamera(ndc, camera);
      let best = Infinity;
      let key = 'sky';
      for (const t of targets) {
        const hit = ray.intersectObject(t.mesh, false)[0];
        if (!hit || hit.distance >= best) continue;
        best = hit.distance;
        const tags = t.mesh.geometry.userData.tint as TintTags | undefined;
        const isRoof =
          t.kind === 'roof' ||
          (t.kind === 'church' && tags?.role[hit.faceIndex ?? 0] === TINT_ROLE.roof);
        const below = (hit.face?.normal.dot(ray.ray.direction) ?? 0) > 0;
        const own = t.kind === 'roof' && tags?.owner[hit.faceIndex ?? 0] === house;
        key = isRoof ? (below ? 'soffit' : own ? 'roof' : 'other roof') : t.kind;
      }
      const o = ray.ray.origin;
      const d = ray.ray.direction;
      for (let s = 0.1; s < Math.min(best, 150); s += 0.03 + 0.01 * s) {
        if (o.y + d.y * s < terrain.heightAt(o.x + d.x * s, o.z + d.z * s)) {
          key = 'terrain';
          break;
        }
      }
      row.push(key);
    }
    out.push(row);
  }
  return out;
}

/** Interior samples per key: the four grid neighbours carry the same key. */
function sampleSets(map: string[][]): Map<string, [number, number][]> {
  const sets = new Map<string, [number, number][]>();
  for (let r = 1; r < map.length - 1; r++) {
    for (let c = 1; c < map[0].length - 1; c++) {
      const key = map[r][c];
      if ([map[r - 1][c], map[r + 1][c], map[r][c - 1], map[r][c + 1]].some((k) => k !== key)) {
        continue;
      }
      if (!sets.has(key)) sets.set(key, []);
      sets.get(key)?.push([c, r]);
    }
  }
  return sets;
}

const pixel = ([c, r]: [number, number]): number =>
  ((r * GRID + GRID / 2) * WIDTH + c * GRID + GRID / 2) * 3;

const labAt = (img: Buffer, s: [number, number]): Lab => {
  const i = pixel(s);
  return linearToLab(srgbToLinear(img[i]), srgbToLinear(img[i + 1]), srgbToLinear(img[i + 2]));
};

function meanLab(img: Buffer, samples: readonly [number, number][]): Lab | null {
  if (samples.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of samples) {
    const i = pixel(s);
    r += srgbToLinear(img[i]);
    g += srgbToLinear(img[i + 1]);
    b += srgbToLinear(img[i + 2]);
  }
  const n = samples.length;
  return linearToLab(r / n, g / n, b / n);
}

/** Mostly magenta, the coverage spec's binary test: R and B above 192, G below 64. */
const isBare = (img: Buffer, s: [number, number]): boolean => {
  const i = pixel(s);
  return img[i] > 192 && img[i + 2] > 192 && img[i + 1] < 64;
};

const { house, poses } = choosePoses();
const maps = poses.map(attribute);
if (dry) {
  const counts = maps.map((m) =>
    Object.fromEntries([...sampleSets(m)].map(([k, v]) => [k, v.length])),
  );
  console.log(JSON.stringify({ house, poses, counts }, null, 2));
  process.exit(0);
}
const url = `${base}?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
mkdirSync(outDir, { recursive: true });
const shots: Record<string, Record<string, Buffer>> = { normal: {}, coverage: {} };
const draws: Record<string, unknown> = {};
try {
  for (const mode of ['normal', 'coverage'] as const) {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.goto(mode === 'coverage' ? `${url}&coverage` : url);
    await page.waitForFunction(
      () => Boolean(window.__goghShot && window.__goghDiag?.().world),
      null,
      {
        timeout: 180_000,
      },
    );
    const frame = (): Promise<number> =>
      page.evaluate(() => {
        const diag = window.__goghDiag;
        if (!diag) throw new Error('no __goghDiag: the url needs ?diag');
        return (diag().renderer as { frame: number }).frame;
      });
    for (const pose of poses) {
      await page.evaluate(
        (p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]),
        [...pose.position, pose.yaw, pose.pitch],
      );
      const start = await frame();
      while ((await frame()) < start + 5) await page.waitForTimeout(30);
      const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      await sharp(png).removeAlpha().png().toFile(`${outDir}/eave-${pose.name}-${mode}-${tag}.png`);
      shots[mode][pose.name] = (await sharp(png).removeAlpha().raw().toBuffer()) as Buffer;
      if (mode === 'normal')
        draws[pose.name] = await page.evaluate(() => {
          const diag = window.__goghDiag?.();
          const programs = (diag?.renderer as { programs?: number } | undefined)?.programs;
          return { ...(diag?.draw as object), programs };
        });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

const sets = maps.map(sampleSets);
const raisedRoof = meanLab(shots.normal.raised, sets[1].get('roof') ?? []);
const results = poses.map((pose, k) => {
  const img = shots.normal[pose.name];
  const cov = shots.coverage[pose.name];
  const soffit = sets[k].get('soffit') ?? [];
  const sky = meanLab(img, sets[k].get('sky') ?? []);
  const soffitMean = meanLab(img, soffit);
  const skyLike =
    sky && raisedRoof
      ? soffit.filter((s) => {
          const lab = labAt(img, s);
          return deltaE2000(lab, sky) < deltaE2000(lab, raisedRoof);
        }).length
      : null;
  let frameBare = 0;
  for (let i = 0; i < cov.length; i += 3) {
    if (cov[i] > 192 && cov[i + 2] > 192 && cov[i + 1] < 64) frameBare++;
  }
  const round = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(2)));
  return {
    pose: pose.name,
    eye: pose.position.map((v) => Number(v.toFixed(2))),
    yaw: Number(pose.yaw.toFixed(3)),
    pitch: pose.pitch,
    draw: draws[pose.name],
    samples: Object.fromEntries([...sets[k].entries()].map(([key, s]) => [key, s.length])),
    soffitSkyLike: skyLike === null || soffit.length === 0 ? null : round(skyLike / soffit.length),
    soffitVsSky: round(soffitMean && sky ? deltaE2000(soffitMean, sky) : null),
    soffitVsRoof: round(soffitMean && raisedRoof ? deltaE2000(soffitMean, raisedRoof) : null),
    soffitL: round(soffitMean ? soffitMean[0] : null),
    roofL: round(raisedRoof ? raisedRoof[0] : null),
    soffitBare:
      soffit.length === 0
        ? null
        : round(soffit.filter((s) => isBare(cov, s)).length / soffit.length),
    frameBarePct: Number(((100 * frameBare) / (WIDTH * HEIGHT)).toFixed(3)),
  };
});
const report = { tag, house, url, results };
console.log(JSON.stringify(report, null, 2));
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
