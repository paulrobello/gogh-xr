/**
 * The café set's building blocks: boxes, beams, walls with real openings (reveals, panes, frames,
 * glazing bars, sills, shutters), roofs, railings and whole street buildings. Each emits triangles
 * into a paint builder. Pure geometry over plain tuples.
 */
import type { Vec3 } from '../../render/strokes/frame';
import type { Paint, PaintBuilder } from './paint';

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function unit(a: Vec3): Vec3 {
  return scale(a, 1 / length(a));
}

export function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const UP: Vec3 = [0, 1, 0];

/** A box from a corner and its three edges. `skip` drops faces: 0/1 the ex ends, 2/3 ey, 4/5 ez. */
export function box(
  builder: PaintBuilder,
  origin: Vec3,
  ex: Vec3,
  ey: Vec3,
  ez: Vec3,
  paint: Paint,
  skip: readonly number[] = [],
  cell?: number,
): void {
  const centre = add(origin, scale(add(add(ex, ey), ez), 0.5));
  const at = (i: number, j: number, k: number): Vec3 =>
    add(origin, add(add(scale(ex, i), scale(ey, j)), scale(ez, k)));
  const faces: [Vec3, Vec3, Vec3, Vec3][] = [
    [at(0, 0, 0), at(0, 1, 0), at(0, 1, 1), at(0, 0, 1)],
    [at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1)],
    [at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)],
    [at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1)],
    [at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(0, 1, 0)],
    [at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)],
  ];
  for (const [i, [a, b, c, d]] of faces.entries()) {
    if (!skip.includes(i)) builder.quad(a, b, c, d, paint, { away: centre, cell });
  }
}

/** A box of `width` by `height` in section, centred on the line from `a` to `b`. */
export function beam(
  builder: PaintBuilder,
  a: Vec3,
  b: Vec3,
  width: number,
  height: number,
  paint: Paint,
): void {
  const along = sub(b, a);
  const direction = unit(along);
  const side = Math.abs(direction[1]) > 0.99 ? ([1, 0, 0] as Vec3) : unit(cross(direction, UP));
  const rise = unit(cross(side, direction));
  const origin = sub(sub(a, scale(side, width / 2)), scale(rise, height / 2));
  box(builder, origin, along, scale(side, width), scale(rise, height), paint);
}

/** A wall's own axes: `s` runs along it from its left end as seen from outside, `out` faces out. */
export interface WallFrame {
  readonly origin: Vec3;
  readonly along: Vec3;
  readonly out: Vec3;
  readonly length: number;
}

/** The wall from `a` to `b` at the ground: seen from outside, `a` is its left end. */
export function wallFrame(a: Vec3, b: Vec3): WallFrame {
  const run: Vec3 = [b[0] - a[0], 0, b[2] - a[2]];
  const along = unit(run);
  return { origin: [a[0], a[1], a[2]], along, out: cross(along, UP), length: length(run) };
}

/** The point `s` along the wall, `y` up it and `proud` metres out of its face. */
export function wallPoint(frame: WallFrame, s: number, y: number, proud = 0): Vec3 {
  return [
    frame.origin[0] + frame.along[0] * s + frame.out[0] * proud,
    frame.origin[1] + y,
    frame.origin[2] + frame.along[2] * s + frame.out[2] * proud,
  ];
}

/** A box in a wall's axes, from `s0` to `s1` along, `y0` to `y1` up and `d0` to `d1` out. */
export function wallBox(
  builder: PaintBuilder,
  frame: WallFrame,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  d0: number,
  d1: number,
  paint: Paint,
  skip: readonly number[] = [],
): void {
  box(
    builder,
    wallPoint(frame, s0, y0, d0),
    scale(frame.along, s1 - s0),
    [0, y1 - y0, 0],
    scale(frame.out, d1 - d0),
    paint,
    skip,
  );
}

export interface Opening {
  readonly s0: number;
  readonly s1: number;
  readonly y0: number;
  readonly y1: number;
  /** How far the pane sits behind the wall's face, metres. */
  readonly depth: number;
  /** Null leaves the opening open, onto whatever stands behind the wall. */
  readonly pane: Paint | null;
  /** The jambs, head and sill of the recess. The wall's paint when absent. */
  readonly reveal?: Paint;
  /** A surround standing proud of the wall. */
  readonly frame?: { readonly paint: Paint; readonly width: number; readonly proud: number };
  /** Glazing bars: how many divide the pane across and up. */
  readonly bars?: { readonly paint: Paint; readonly across: number; readonly up: number };
  readonly sill?: Paint;
  /** A pair of shutters folded back against the wall. */
  readonly shutters?: Paint;
}

/** A wall from `y0` to `y1` with its openings cut through it and built in depth. */
export function wall(
  builder: PaintBuilder,
  frame: WallFrame,
  y0: number,
  y1: number,
  openings: readonly Opening[],
  paint: Paint,
  cell = 0.5,
): void {
  const cuts = (values: number[], low: number, high: number): number[] =>
    [...new Set(values.map((value) => Math.min(high, Math.max(low, value))))].sort((a, b) => a - b);
  const ss = cuts(
    [0, frame.length, ...openings.flatMap(({ s0, s1 }) => [s0, s1])],
    0,
    frame.length,
  );
  const ys = cuts([y0, y1, ...openings.flatMap((opening) => [opening.y0, opening.y1])], y0, y1);
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < ss.length; i++) {
      const s = (ss[i] + ss[i + 1]) / 2;
      const y = (ys[j] + ys[j + 1]) / 2;
      if (openings.some((o) => s > o.s0 && s < o.s1 && y > o.y0 && y < o.y1)) continue;
      builder.quad(
        wallPoint(frame, ss[i], ys[j]),
        wallPoint(frame, ss[i + 1], ys[j]),
        wallPoint(frame, ss[i + 1], ys[j + 1]),
        wallPoint(frame, ss[i], ys[j + 1]),
        paint,
        { cell },
      );
    }
  }
  for (const opening of openings) recess(builder, frame, opening, paint);
}

function recess(builder: PaintBuilder, frame: WallFrame, opening: Opening, wallPaint: Paint): void {
  const { s0, s1, y0, y1, depth, pane } = opening;
  const reveal = opening.reveal ?? wallPaint;
  const centre = wallPoint(frame, (s0 + s1) / 2, (y0 + y1) / 2, -depth / 2);
  const at = (s: number, y: number, back: boolean): Vec3 =>
    wallPoint(frame, s, y, back ? -depth : 0);
  const side = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void =>
    builder.quad(a, b, c, d, reveal, { toward: centre });
  side(at(s0, y0, false), at(s0, y0, true), at(s0, y1, true), at(s0, y1, false));
  side(at(s1, y0, false), at(s1, y0, true), at(s1, y1, true), at(s1, y1, false));
  side(at(s0, y1, false), at(s1, y1, false), at(s1, y1, true), at(s0, y1, true));
  side(at(s0, y0, false), at(s1, y0, false), at(s1, y0, true), at(s0, y0, true));
  if (pane) {
    builder.quad(at(s0, y0, true), at(s1, y0, true), at(s1, y1, true), at(s0, y1, true), pane, {
      cell: 0.6,
    });
  }
  if (opening.frame) {
    const { paint, width, proud } = opening.frame;
    wallBox(builder, frame, s0 - width, s0, y0, y1 + width, 0, proud, paint, [4]);
    wallBox(builder, frame, s1, s1 + width, y0, y1 + width, 0, proud, paint, [4]);
    wallBox(builder, frame, s0, s1, y1, y1 + width, 0, proud, paint, [0, 1, 4]);
  }
  if (opening.sill) {
    wallBox(builder, frame, s0 - 0.09, s1 + 0.09, y0 - 0.08, y0, 0, 0.13, opening.sill, [4]);
  }
  if (opening.bars) {
    const { paint, across, up } = opening.bars;
    const bar = 0.022;
    for (let i = 1; i <= across; i++) {
      const s = s0 + ((s1 - s0) * i) / (across + 1);
      wallBox(builder, frame, s - bar, s + bar, y0, y1, -depth, -depth + 0.035, paint, [2, 3, 4]);
    }
    for (let j = 1; j <= up; j++) {
      const y = y0 + ((y1 - y0) * j) / (up + 1);
      wallBox(builder, frame, s0, s1, y - bar, y + bar, -depth, -depth + 0.035, paint, [0, 1, 4]);
    }
  }
  if (opening.shutters) {
    const leaf = (s1 - s0) / 2;
    // Folded back against the wall, each a little ajar.
    const ajar = 0.2;
    for (const [hinge, turn] of [
      [s0, -1],
      [s1, 1],
    ] as const) {
      const run = add(
        scale(frame.along, turn * leaf * Math.cos(ajar)),
        scale(frame.out, leaf * Math.sin(ajar)),
      );
      const thick = scale(unit(cross(run, UP)), 0.04 * -turn);
      box(
        builder,
        wallPoint(frame, hinge, y0 + 0.02, 0.025),
        run,
        [0, y1 - y0 - 0.04, 0],
        thick,
        opening.shutters,
      );
    }
  }
}

/**
 * A pitched roof over four eave corners, in order around the roof: its ridge joins the middle of
 * side 0-1 to the middle of side 2-3, `rise` above them, pulled in by `hip` of its length each end.
 */
export function roof(
  builder: PaintBuilder,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  rise: number,
  paint: Paint,
  hip = 0,
  cell = 2,
): void {
  const [c0, c1, c2, c3] = corners;
  const m01 = mix(c0, c1, 0.5);
  const m23 = mix(c2, c3, 0.5);
  const r01 = add(mix(m01, m23, hip), [0, rise, 0]);
  const r23 = add(mix(m23, m01, hip), [0, rise, 0]);
  const centre = mix(m01, m23, 0.5);
  builder.quad(c1, c2, r23, r01, paint, { away: centre, cell });
  builder.quad(c3, c0, r01, r23, paint, { away: centre, cell });
  builder.triangle(c0, c1, r01, paint, { away: centre });
  builder.triangle(c2, c3, r23, paint, { away: centre });
}

/** An iron railing from `a` to `b`: two rails and a baluster every `spacing` metres. */
export function railing(
  builder: PaintBuilder,
  a: Vec3,
  b: Vec3,
  height: number,
  paint: Paint,
  spacing = 0.14,
): void {
  const lift = (p: Vec3, y: number): Vec3 => [p[0], p[1] + y, p[2]];
  beam(builder, lift(a, height), lift(b, height), 0.045, 0.035, paint);
  beam(builder, lift(a, 0.1), lift(b, 0.1), 0.03, 0.03, paint);
  const count = Math.max(1, Math.round(length(sub(b, a)) / spacing));
  for (let i = 0; i <= count; i++) {
    const foot = mix(a, b, i / count);
    const thick = i === 0 || i === count ? 0.045 : 0.018;
    beam(builder, foot, lift(foot, height), thick, thick, paint);
  }
}

export interface BuildingPaints {
  readonly wall: Paint;
  readonly roof: Paint;
  /** A lit window and a dark one. */
  readonly lit: Paint;
  readonly dark: Paint;
  readonly trim: Paint;
  readonly shutter: Paint;
}

export interface Building {
  /** The ground plan, corners in order either way round, as [x, z]. */
  readonly plan: readonly (readonly [number, number])[];
  readonly height: number;
  /** Ridge height above the eaves. 0 is a flat roof behind a cornice. */
  readonly rise?: number;
  readonly paints: BuildingPaints;
  /** Sill height of each floor's windows. */
  readonly floors: readonly number[];
  /** Sides with no windows, by the index of their first corner. */
  readonly blind?: readonly number[];
  /** Windows by hand for a side, replacing the pattern. */
  readonly openings?: Readonly<Record<number, readonly Opening[]>>;
  /** Chance a patterned window is lit, 0 to 1. */
  readonly lit?: number;
  readonly chimneys?: number;
  readonly cell?: number;
  /** False leaves the glazing bars, sills and shutters off, for a building seen only from afar. */
  readonly detail?: boolean;
}

/** A street building: walls with windows in depth, a cornice, a roof and chimneys. */
export function building(builder: PaintBuilder, spec: Building, random: () => number): void {
  const { plan, height, paints } = spec;
  const cx = plan.reduce((sum, [x]) => sum + x, 0) / plan.length;
  const cz = plan.reduce((sum, [, z]) => sum + z, 0) / plan.length;
  const cell = spec.cell ?? 1;
  for (let i = 0; i < plan.length; i++) {
    let a: Vec3 = [plan[i][0], 0, plan[i][1]];
    let b: Vec3 = [plan[(i + 1) % plan.length][0], 0, plan[(i + 1) % plan.length][1]];
    let frame = wallFrame(a, b);
    // Seen from outside, a wall runs left to right.
    const mid = mix(a, b, 0.5);
    if (frame.out[0] * (mid[0] - cx) + frame.out[2] * (mid[2] - cz) < 0) {
      [a, b] = [b, a];
      frame = wallFrame(a, b);
    }
    const openings: Opening[] = [...(spec.openings?.[i] ?? [])];
    if (!spec.openings?.[i] && !spec.blind?.includes(i)) {
      const bays = Math.floor((frame.length - 1.2) / 2.1);
      const start = (frame.length - (bays - 1) * 2.1) / 2;
      for (const sill of spec.floors) {
        if (sill + 1.7 > height - 0.4) continue;
        for (let bay = 0; bay < bays; bay++) {
          if (random() < 0.12) continue;
          const s = start + bay * 2.1;
          const lit = random() < (spec.lit ?? 0.25);
          openings.push({
            s0: s - 0.5,
            s1: s + 0.5,
            y0: sill,
            y1: sill + 1.6,
            depth: 0.22,
            pane: lit ? paints.lit : paints.dark,
            bars: spec.detail === false ? undefined : { paint: paints.trim, across: 1, up: 2 },
            sill: spec.detail === false ? undefined : paints.trim,
            shutters: random() < 0.55 ? paints.shutter : undefined,
          });
        }
      }
    }
    wall(builder, frame, 0, height, openings, paints.wall, cell);
    // The cornice under the eaves.
    wallBox(
      builder,
      frame,
      -0.2,
      frame.length + 0.2,
      height - 0.3,
      height,
      0,
      0.2,
      paints.trim,
      [4],
    );
  }
  const top = plan.map(([x, z]): Vec3 => [x, height, z]);
  if (plan.length === 4 && (spec.rise ?? 0) > 0) {
    // The ridge runs the building's long way.
    const first = length(sub(top[1], top[0])) < length(sub(top[2], top[1])) ? 0 : 1;
    const out = (p: Vec3): Vec3 => [p[0] + (p[0] - cx) * 0.05, p[1], p[2] + (p[2] - cz) * 0.05];
    const ring = [0, 1, 2, 3].map((k) => out(top[(first + k) % 4])) as [Vec3, Vec3, Vec3, Vec3];
    roof(builder, ring, spec.rise ?? 0, paints.roof, 0.18, 2.5);
  } else {
    for (let i = 1; i + 1 < top.length; i++) {
      builder.triangle(top[0], top[i], top[i + 1], paints.roof, { toward: [cx, height + 50, cz] });
    }
  }
  for (let i = 0; i < (spec.chimneys ?? 0); i++) {
    const t = 0.25 + 0.5 * random();
    const k = Math.floor(random() * plan.length);
    const [ax, az] = plan[k];
    const x = ax + (cx - ax) * t;
    const z = az + (cz - az) * t;
    const tall = (spec.rise ?? 0) + 0.6 + random() * 0.8;
    box(builder, [x - 0.3, height, z - 0.3], [0.6, 0, 0], [0, tall, 0], [0, 0, 0.6], paints.wall);
  }
}
