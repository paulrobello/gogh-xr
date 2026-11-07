/**
 * Ground-level village contrast (ruling Q28, A1): captures the seed-1 Starry Night world from
 * ground-level poses beside houses and the church, attributes pixels to the surfaces they show, and
 * reports how far apart the walls, roofs and nearby ground read.
 *
 *   bun scripts/village-contrast.ts <base-url> [--tag after] [--out docs/shots] [--json out.json]
 *
 * Captures `?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1` at 1280 × 720 through
 * `__goghPose` in headless Chromium on the GPU. Poses are fixed by rule from the seed-1 village
 * before any capture: the house nearest the painter's spot seen from in front (its wall facing the
 * spot) and from behind, the next house seen at a gable, and the church from in front. Each eye
 * stands 7 m out from the wall's centre along its normal, 1.6 m above the ground, facing the wall,
 * pitched 0.1 rad down so the ground shows. From 7 m the wall top hides the roof, so a fifth pose
 * stands 15 m out from the nearest house's eave-side back wall, level, where its roof shows. A house is skipped, in distance order, when the eye
 * would stand inside an outline or the ray to its wall's centre first meets something else.
 *
 * Attribution is geometric, with no shader change: the desktop camera (70° vertical, YXZ yaw then
 * pitch) is rebuilt on the CPU, every 4th pixel casts a ray against the village, window, church
 * and cypress base meshes and marches the terrain's `heightAt`, and the nearest hit names the
 * pixel's surface (layer, owning house, church wall or not). A sample counts only where its four
 * grid neighbours name the same surface, which drops silhouettes, MSAA rims and the strokes that
 * reach past an edge. "Nearby ground" is the terrain inside the target's box grown by 64 px.
 *
 * ΔE is CIEDE2000 between the mean colours of two pixel sets, averaged in linear light (the
 * fidelity metric's block-mean convention), so it measures whether two surfaces read as different
 * paint, not their stroke texture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import {
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
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
const outDir = option('out') ?? 'docs/shots';
const jsonPath = option('json');
const [base] = args;
if (!base) {
  console.error(
    'usage: bun scripts/village-contrast.ts <base-url> [--tag T] [--out DIR] [--json F]',
  );
  process.exit(2);
}

const WIDTH = 1280;
const HEIGHT = 720;
const GRID = 4;
const STAND_OFF = 7;
const PITCH = -0.1;
const EYE = 1.6;
const NEAR_GROUND_PX = 64;

const world = createWorldGeometry(worldSeeds(1));
const { village, terrain } = world;
const geos = village.geometries;
// Front faces only, as the base meshes draw them: a roof overhang seen from below shows what lies past it.
const material = new MeshBasicMaterial({ side: FrontSide });
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
  /** The house index, or -1 for the church. */
  readonly target: number;
}

/** Eye 7 m out along a wall's outward normal from its centre, facing it. */
function poseAt(
  name: string,
  target: number,
  cx: number,
  cz: number,
  nx: number,
  nz: number,
  off: number = STAND_OFF,
): Pose {
  const x = cx + nx * off;
  const z = cz + nz * off;
  return {
    name,
    position: [x, terrain.heightAt(x, z) + EYE, z],
    yaw: Math.atan2(nx, nz),
    pitch: PITCH,
    target,
  };
}

/** A wall of house `h`: local ±z long walls, ±x gables, ranked by facing the painter's spot. */
function houseWalls(
  h: number,
): { cx: number; cz: number; nx: number; nz: number; gable: boolean; facing: number }[] {
  const house = village.houses[h];
  const c = Math.cos(house.yaw);
  const s = Math.sin(house.yaw);
  const walls = [
    { lx: 0, lz: 1, half: house.depth / 2, gable: false },
    { lx: 0, lz: -1, half: house.depth / 2, gable: false },
    { lx: 1, lz: 0, half: house.width / 2, gable: true },
    { lx: -1, lz: 0, half: house.width / 2, gable: true },
  ];
  return walls.map((w) => {
    const nx = w.lx * c + w.lz * s;
    const nz = -w.lx * s + w.lz * c;
    const cx = house.center[0] + nx * w.half;
    const cz = house.center[2] + nz * w.half;
    const toSpot = Math.hypot(cx, cz);
    return { cx, cz, nx, nz, gable: w.gable, facing: (-cx * nx - cz * nz) / toSpot };
  });
}

/** The eye stands clear of every house and the church, by 0.5 m. */
function standsClear(pose: Pose): boolean {
  const [x, , z] = pose.position;
  const inside = (poly: readonly (readonly [number, number])[]): boolean => {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      const ex = bx - ax;
      const ez = bz - az;
      const len = Math.hypot(ex, ez);
      const d = ((x - ax) * ez - (z - az) * ex) / len;
      if (d > 0.5) return false;
      sign++;
    }
    return sign > 0;
  };
  return ![...village.houses.map((h) => h.outline), village.church.outline].some((o) =>
    inside(o as readonly (readonly [number, number])[]),
  );
}

/** The ray from the eye to the wall's centre, half way up, first meets that house's walls. */
function seesWall(pose: Pose, h: number, cx: number, cz: number): boolean {
  const house = village.houses[h];
  const ray = new Raycaster();
  const from = new Vector3(...pose.position);
  const to = new Vector3(cx, house.center[1] + house.eaveHeight / 2, cz);
  ray.set(from, to.clone().sub(from).normalize());
  let best = Infinity;
  let kind = '';
  let owner = -1;
  for (const t of targets) {
    const hit = ray.intersectObject(t.mesh, false)[0];
    if (!hit || hit.distance >= best) continue;
    best = hit.distance;
    kind = t.kind;
    owner =
      (t.mesh.geometry.userData.tint as TintTags | undefined)?.owner[hit.faceIndex ?? 0] ?? -1;
  }
  return kind === 'building' && owner === h;
}

function choosePoses(): Pose[] {
  const order = village.houses
    .map((h, i) => ({ i, d: Math.hypot(h.center[0], h.center[2]) }))
    .sort((a, b) => a.d - b.d)
    .map(({ i }) => i);
  const poses: Pose[] = [];
  const pick = (
    name: string,
    exclude: number,
    choose: (h: number) => ReturnType<typeof houseWalls>[number],
    off: number = STAND_OFF,
  ): number => {
    for (const h of order) {
      if (h === exclude) continue;
      const w = choose(h);
      const pose = {
        ...poseAt(name, h, w.cx, w.cz, w.nx, w.nz, off),
        pitch: off > STAND_OFF ? 0 : PITCH,
      };
      if (standsClear(pose) && seesWall(pose, h, w.cx, w.cz)) {
        poses.push(pose);
        return h;
      }
    }
    throw new Error(`no clear pose for ${name}`);
  };
  const front = pick('house front', -1, (h) =>
    houseWalls(h).reduce((a, b) => (b.facing > a.facing ? b : a)),
  );
  pick('house back', -1, (h) => houseWalls(h).reduce((a, b) => (b.facing < a.facing ? b : a)));
  pick('house gable', front, (h) =>
    houseWalls(h)
      .filter((w) => w.gable)
      .reduce((a, b) => (b.facing > a.facing ? b : a)),
  );
  // From 7 m the wall top hides the roof, so the roofs get a level pose 15 m out from the long
  // (eave-side) wall facing most away from the spot, where a roof slope faces the eye.
  pick(
    'house roofs',
    -1,
    (h) =>
      houseWalls(h)
        .filter((w) => !w.gable)
        .reduce((a, b) => (b.facing < a.facing ? b : a)),
    15,
  );
  const xs = village.church.footprint.map((p) => p[0]);
  const zs = village.church.footprint.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  poses.push({ ...poseAt('church front', -1, cx, Math.max(...zs), 0, 1), pitch: 0.05 });
  poses.push({ ...poseAt('church back', -1, cx, Math.min(...zs), 0, -1), pitch: 0.05 });
  return poses;
}

/** Surface key per grid sample: '' for none, else e.g. 'building:3', 'roof:3', 'church:wall'. */
function attribute(pose: Pose): string[][] {
  const camera = new PerspectiveCamera(70, WIDTH / HEIGHT, 0.1, 1000);
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pose.pitch, pose.yaw, 0);
  camera.updateMatrixWorld();
  const ray = new Raycaster();
  const cols = WIDTH / GRID;
  const rows = HEIGHT / GRID;
  const out: string[][] = [];
  const ndc = new Vector2();
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      ndc.set(((c * GRID + GRID / 2) / WIDTH) * 2 - 1, 1 - ((r * GRID + GRID / 2) / HEIGHT) * 2);
      ray.setFromCamera(ndc, camera);
      let best = Infinity;
      let key = '';
      for (const t of targets) {
        const hit = ray.intersectObject(t.mesh, false)[0];
        if (!hit || hit.distance >= best) continue;
        best = hit.distance;
        const tags = t.mesh.geometry.userData.tint as TintTags | undefined;
        const f = hit.faceIndex ?? 0;
        if (t.kind === 'building' || t.kind === 'roof') key = `${t.kind}:${tags?.owner[f]}`;
        else if (t.kind === 'church')
          key = tags?.role[f] === TINT_ROLE.churchWall ? 'church:wall' : 'church:dark';
        else key = t.kind;
      }
      const o = ray.ray.origin;
      const d = ray.ray.direction;
      let prev = 0;
      for (let s = 0.1; s < Math.min(best, 150); s += 0.03 + 0.01 * s) {
        if (o.y + d.y * s < terrain.heightAt(o.x + d.x * s, o.z + d.z * s)) {
          let lo = prev;
          let hi = s;
          for (let k = 0; k < 12; k++) {
            const m = (lo + hi) / 2;
            if (o.y + d.y * m < terrain.heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m;
            else lo = m;
          }
          if (hi < best) key = 'terrain';
          break;
        }
        prev = s;
      }
      row.push(key);
    }
    out.push(row);
  }
  return out;
}

interface Stats {
  readonly n: number;
  readonly lab: Lab | null;
}

function meanLab(img: Buffer, samples: readonly [number, number][]): Stats {
  if (samples.length === 0) return { n: 0, lab: null };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [c, row] of samples) {
    const i = ((row * GRID + GRID / 2) * WIDTH + c * GRID + GRID / 2) * 3;
    r += srgbToLinear(img[i]);
    g += srgbToLinear(img[i + 1]);
    b += srgbToLinear(img[i + 2]);
  }
  const n = samples.length;
  return { n, lab: linearToLab(r / n, g / n, b / n) };
}

const poses = choosePoses();
const maps = poses.map(attribute);
const url = `${base}?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
const results: Record<string, unknown>[] = [];
mkdirSync(outDir, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.goto(url);
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
  for (const [k, pose] of poses.entries()) {
    await page.evaluate(
      (p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]),
      [...pose.position, pose.yaw, pose.pitch],
    );
    const start = await frame();
    while ((await frame()) < start + 4) await page.waitForTimeout(30);
    const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const slug = pose.name.replace(/\s+/g, '-');
    await sharp(png).removeAlpha().png().toFile(`${outDir}/village-${slug}-${tag}.png`);
    const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    const map = maps[k];
    const rows = map.length;
    const cols = map[0].length;
    const sets = new Map<string, [number, number][]>();
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const key = map[r][c];
        if (!key) continue;
        if (
          map[r - 1][c] !== key ||
          map[r + 1][c] !== key ||
          map[r][c - 1] !== key ||
          map[r][c + 1] !== key
        )
          continue;
        if (!sets.has(key)) sets.set(key, []);
        sets.get(key)?.push([c, r]);
      }
    }
    const wallKey = pose.target >= 0 ? `building:${pose.target}` : 'church:wall';
    const roofKey = pose.target >= 0 ? `roof:${pose.target}` : 'church:dark';
    const target = [...(sets.get(wallKey) ?? []), ...(sets.get(roofKey) ?? [])];
    const pad = NEAR_GROUND_PX / GRID;
    const box = target.reduce(
      ([x0, y0, x1, y1], [c, r]) => [
        Math.min(x0, c),
        Math.min(y0, r),
        Math.max(x1, c),
        Math.max(y1, r),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    const ground = (sets.get('terrain') ?? []).filter(
      ([c, r]) => c >= box[0] - pad && c <= box[2] + pad && r >= box[1] - pad && r <= box[3] + pad,
    );
    const otherWalls = [...sets.entries()]
      .filter(([key]) => key.startsWith('building:') && key !== wallKey)
      .flatMap(([, s]) => s);
    const wallSamples = sets.get(wallKey) ?? [];
    const wall = meanLab(data, wallSamples);
    // Upper and lower half of the target wall on screen, split at its middle grid row.
    const wallRows = wallSamples.map(([, r]) => r);
    const midRow = wallRows.length > 0 ? (Math.min(...wallRows) + Math.max(...wallRows)) / 2 : 0;
    const wallTop = meanLab(
      data,
      wallSamples.filter(([, r]) => r < midRow),
    );
    const wallBottom = meanLab(
      data,
      wallSamples.filter(([, r]) => r >= midRow),
    );
    const roof = meanLab(data, sets.get(roofKey) ?? []);
    const near = meanLab(data, ground);
    const houses = meanLab(data, otherWalls);
    const dE = (a: Stats, b: Stats): number | null =>
      a.lab && b.lab ? deltaE2000(a.lab, b.lab) : null;
    results.push({
      pose: pose.name,
      target: pose.target,
      eye: pose.position.map((v) => Number(v.toFixed(2))),
      yaw: Number(pose.yaw.toFixed(3)),
      pitch: pose.pitch,
      samples: { wall: wall.n, roof: roof.n, ground: near.n, houseWalls: houses.n },
      wallGround: dE(wall, near),
      roofWall: dE(roof, wall),
      roofGround: dE(roof, near),
      wallTopL: wallTop.lab?.[0] ?? null,
      wallBottomL: wallBottom.lab?.[0] ?? null,
      wallL: wall.lab?.[0] ?? null,
      roofL: roof.lab?.[0] ?? null,
      groundL: near.lab?.[0] ?? null,
      houseWallL: houses.lab?.[0] ?? null,
      lab: Object.fromEntries(
        Object.entries({ wall, roof, ground: near, houseWalls: houses }).map(([k, v]) => [
          k,
          v.lab?.map((x) => Number(x.toFixed(1))) ?? null,
        ]),
      ),
    });
  }
} finally {
  await browser.close();
}
const f = (v: unknown): string => (typeof v === 'number' ? v.toFixed(1) : String(v));
console.log(
  '| pose | eye | yaw | wall–ground ΔE | roof–wall ΔE | roof–ground ΔE | L* wall / roof / ground / other house walls | L* wall upper / lower half | samples wall / roof / ground |',
);
for (const r of results) {
  const s = r.samples as Record<string, number>;
  console.log(
    `| ${r.pose} (${(r.target as number) >= 0 ? `house ${r.target}` : 'church'}) | ${(r.eye as number[]).join(', ')} | ${r.yaw} | ${f(r.wallGround)} | ${f(r.roofWall)} | ${f(r.roofGround)} | ${f(r.wallL)} / ${f(r.roofL)} / ${f(r.groundL)} / ${f(r.houseWallL)} | ${f(r.wallTopL)} / ${f(r.wallBottomL)} | ${s.wall} / ${s.roof} / ${s.ground} |`,
  );
}
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
