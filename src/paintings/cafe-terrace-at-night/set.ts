/**
 * The café set as geometry: the café building with its blue shopfront, open doorway and lit room,
 * the awning on its frame, the balcony and shuttered windows above it, the raised deck, the wing
 * that closes the terrace, and the street and square around them. Everything stands where
 * layout.ts measured it off the scan. Pure geometry, no WebGL.
 */
import type { Vec3 } from '../../render/strokes/frame';
import type { Steps } from '../../util/slicer';
import {
  add,
  type Building,
  type BuildingPaints,
  beam,
  box,
  building,
  mix,
  type Opening,
  railing,
  roof,
  scale,
  unit,
  type WallFrame,
  wall,
  wallBox,
  wallFrame,
  wallPoint,
} from './kit';
import {
  AWNING,
  DECK,
  DECK_HEIGHT,
  DOORWAY,
  DOORWAY_HEAD,
  facadeX,
  ID,
  NEAR_Z,
  REAR_DEPTH,
  REAR_LEFT_TOP,
  REAR_LEFT_X,
  REAR_RIGHT,
  REAR_Z,
  ROOF,
  SWATCH,
} from './layout';
import type { Paint, PaintBuilder, Swatch } from './paint';

function paint(id: number, swatch: Swatch, tint: number, more: Partial<Paint> = {}): Paint {
  return { id, swatch, tint, ...more };
}

const GROUND = paint(ID.ground, SWATCH.cobbles, 0x4d5a78);
const DECK_TOP = paint(ID.deck, SWATCH.deck, 0xc98a2e);
const DECK_EDGE = paint(ID.deck, SWATCH.deck, 0x7a3f22);
const LIT_WALL = paint(ID.facade, SWATCH.wall, 0xd8b23c);
const DOOR_FRAME = paint(ID.facade, SWATCH.wall, 0xb47428);
const LIT_PANE = paint(ID.facade, SWATCH.wall, 0xf4c84e, { painted: false, lit: true });
const SHOP_GLASS = paint(ID.facade, SWATCH.wall, 0xc7c868, { lit: true });
const WOOD = paint(ID.shopfront, SWATCH.wood, 0x3f68ad);
const WOOD_PALE = paint(ID.shopfront, SWATCH.wood, 0x5a82c4);
const NAVY = paint(ID.shopfront, SWATCH.wood, 0x18244f);
const RED_BAR = paint(ID.shopfront, SWATCH.wood, 0xb5402a);
const ROOM_WALL = paint(ID.interior, SWATCH.wall, 0xe0a030, { painted: false, lit: true });
const ROOM_FLOOR = paint(ID.interior, SWATCH.deck, 0x9b5c26, { painted: false, lit: true });
const ROOM_CEILING = paint(ID.interior, SWATCH.wall, 0xc88f34, { painted: false, lit: true });
const COUNTER = paint(ID.interior, SWATCH.wood, 0x5b3519, { painted: false, lit: true });
const BOTTLES = [0x4f7a3a, 0xd9a53a, 0x8a3a22, 0xc9c27a].map((tint) =>
  paint(ID.interior, SWATCH.wall, tint, { painted: false, lit: true }),
);
const UPPER = paint(ID.upper, SWATCH.plaster, 0x6a84bd);
const UPPER_TRIM = paint(ID.upper, SWATCH.plaster, 0x8fa3cf);
const DARK_PANE = paint(ID.upper, SWATCH.dark, 0x141d44, { painted: false });
const WARM_PANE = paint(ID.upper, SWATCH.wall, 0xe9b545, { painted: false, lit: true });
const SHUTTER_GREEN = paint(ID.upper, SWATCH.shutter, 0x2f6b4c);
const SHUTTER_BLUE = paint(ID.upper, SWATCH.shutter, 0x2a3f78);
const TILES = paint(ID.upper, SWATCH.dark, 0x1c2a52, { painted: false });
const IRON = paint(ID.balcony, SWATCH.dark, 0x232c4a, { painted: false });
/** The awning's frame, lit from below by the lantern. */
const RAFTER = paint(ID.awning, SWATCH.awning, 0x7a5f24, { painted: false });
const BALCONY = paint(ID.balcony, SWATCH.plaster, 0x7f8fb5, { painted: false });
const CANVAS = paint(ID.awning, SWATCH.awning, 0xd7a52c);
const CANVAS_TOP = paint(ID.awning, SWATCH.awning, 0x8f6f28, { painted: false });
const WING = paint(ID.rearWing, SWATCH.plaster, 0x5673ad);
const WING_DOOR = paint(ID.rearWing, SWATCH.wall, 0xf0c044, { painted: false, lit: true });
const WING_DARK = paint(ID.rearWing, SWATCH.dark, 0x16224a, { painted: false });
const WING_SIDE = paint(ID.rearSide, SWATCH.plaster, 0x1f3266);
const WING_PANE = paint(ID.rearSide, SWATCH.dark, 0x10183a, { painted: false });
const WING_GLOW = paint(ID.rearSide, SWATCH.wall, 0xeaa838, { painted: false, lit: true });
/** Wrought iron in the lantern's light. */
const RED_IRON = paint(ID.balcony, SWATCH.wood, 0xb5482a, { painted: false, lit: true });

const UP_FAR: Vec3 = [0, 500, -12];

/** A cloth sheet: the same quad facing both ways, each side with its own paint. */
function sheet(
  set: PaintBuilder,
  corners: [Vec3, Vec3, Vec3, Vec3],
  front: Paint,
  back: Paint,
  toward: Vec3,
  cell?: number,
): void {
  const [a, b, c, d] = corners;
  set.quad(a, b, c, d, front, { toward, cell });
  set.quad(a, b, c, d, back, { away: toward, cell });
}

function ground(set: PaintBuilder): void {
  const level = (x0: number, x1: number, z0: number, z1: number, cell: number): void =>
    set.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], GROUND, { toward: UP_FAR, cell });
  // Fine where the walk goes, coarse out to the buildings that close the view.
  level(-6, 9, 3, -30, 0.3);
  level(-34, -6, 22, -60, 2);
  level(9, 40, 22, -60, 2);
  level(-6, 9, 22, 3, 1);
  level(-6, 9, -30, -60, 1);
  const top = DECK.map(([x, , z]): Vec3 => [x, DECK_HEIGHT, z]);
  set.quad(top[0], top[1], top[2], top[3], DECK_TOP, { toward: UP_FAR, cell: 0.25 });
  set.quad(DECK[0], DECK[1], top[1], top[0], DECK_EDGE, { toward: [0, 0.03, 0] });
  set.quad(DECK[1], DECK[2], top[2], top[1], DECK_EDGE, { toward: [8, 0.03, -12] });
}

/** A window with shutters and a sill, `width` wide about `s`. */
function shuttered(
  s: number,
  y0: number,
  y1: number,
  pane: Paint,
  shutters: Paint,
  width = 1.1,
): Opening {
  return {
    s0: s - width / 2,
    s1: s + width / 2,
    y0,
    y1,
    depth: 0.22,
    pane,
    bars: { paint: UPPER_TRIM, across: 1, up: 2 },
    frame: { paint: UPPER_TRIM, width: 0.09, proud: 0.05 },
    sill: UPPER_TRIM,
    shutters,
  };
}

function* cafe(set: PaintBuilder): Steps<void> {
  const front = wallFrame([facadeX(NEAR_Z), 0, NEAR_Z], [REAR_LEFT_X, 0, REAR_Z]);
  const long = front.length;
  const line = AWNING[0][1];

  // The blue shopfront beside the painter: three lit bays, a panelled pier and its entablature.
  const bay = (s0: number, s1: number): Opening => ({
    s0,
    s1,
    y0: 0.69,
    y1: 2.42,
    depth: 0.3,
    pane: SHOP_GLASS,
    reveal: NAVY,
    bars: { paint: RED_BAR, across: 1, up: 1 },
  });
  const split = 7.3;
  wall(
    set,
    wallFrame(front.origin, wallPoint(front, split, 0)),
    0,
    line,
    [bay(0.6, 2.55), bay(2.7, 4.7), bay(4.85, 6.86)],
    NAVY,
    0.4,
  );
  const cafeWall = wallFrame(wallPoint(front, split, 0), wallPoint(front, long, 0));
  const lit = (opening: Opening): Opening => ({
    ...opening,
    s0: opening.s0 - split,
    s1: opening.s1 - split,
  });
  wall(
    set,
    cafeWall,
    0,
    line,
    [
      // The wide doorway into the lit room.
      lit({
        s0: DOORWAY[0],
        s1: DOORWAY[1],
        y0: DECK_HEIGHT,
        y1: DOORWAY_HEAD,
        depth: 0.4,
        pane: null,
        frame: { paint: DOOR_FRAME, width: 0.12, proud: 0.06 },
      }),
      lit({
        s0: 18,
        s1: 19.3,
        y0: DECK_HEIGHT,
        y1: 2.6,
        depth: 0.18,
        pane: LIT_PANE,
        bars: { paint: DOOR_FRAME, across: 1, up: 3 },
        frame: { paint: DOOR_FRAME, width: 0.1, proud: 0.05 },
      }),
      lit({
        s0: 20.6,
        s1: 22.2,
        y0: 0.95,
        y1: 2.5,
        depth: 0.18,
        pane: LIT_PANE,
        bars: { paint: DOOR_FRAME, across: 1, up: 1 },
        frame: { paint: DOOR_FRAME, width: 0.1, proud: 0.05 },
        sill: DOOR_FRAME,
      }),
    ],
    LIT_WALL,
    0.4,
  );
  // The lit wall carries on over the shopfront's entablature, up to the awning's line.
  wallBox(set, front, 0, split, 3.5, line, 0, 0.02, LIT_WALL, [4]);
  wallBox(set, front, 0.4, 7.3, 0, 0.69, 0, 0.06, WOOD, [4]);
  wallBox(set, front, 6.86, 7.3, 0.69, 2.65, 0, 0.04, NAVY, [4]);
  wallBox(set, front, 7.3, 9.4, 0, 2.65, 0, 0.14, WOOD, [4]);
  wallBox(set, front, 7.62, 9.08, 0.85, 2.3, 0.14, 0.165, WOOD_PALE, [4]);
  wallBox(set, front, 7.24, 9.46, 0, 0.26, 0, 0.2, WOOD, [4]);
  wallBox(set, front, 7.24, 9.46, 2.65, 2.86, 0, 0.2, WOOD_PALE, [4]);
  wallBox(set, front, 0.3, 9.5, 2.86, 3.4, 0, 0.3, WOOD, [4]);
  wallBox(set, front, 0.2, 9.62, 3.4, 3.5, 0, 0.42, WOOD_PALE, [4]);

  yield;

  // The lit room behind the doorway: floor, walls, ceiling, a counter and its bottles.
  const room = (s: number, y: number, back: number): Vec3 => wallPoint(front, s, y, -back);
  const heart = room(13.9, 1.6, 2.2);
  const inside = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, colour: Paint): void =>
    set.quad(a, b, c, d, colour, { toward: heart, cell: 1 });
  const [s0, s1, low, high, deep] = [11.2, 16.7, DECK_HEIGHT, 3.3, 4.2];
  inside(
    room(s0, low, 0.4),
    room(s1, low, 0.4),
    room(s1, low, deep),
    room(s0, low, deep),
    ROOM_FLOOR,
  );
  inside(
    room(s0, high, 0.4),
    room(s1, high, 0.4),
    room(s1, high, deep),
    room(s0, high, deep),
    ROOM_CEILING,
  );
  inside(
    room(s0, low, deep),
    room(s1, low, deep),
    room(s1, high, deep),
    room(s0, high, deep),
    ROOM_WALL,
  );
  inside(
    room(s0, low, 0.4),
    room(s0, low, deep),
    room(s0, high, deep),
    room(s0, high, 0.4),
    ROOM_WALL,
  );
  inside(
    room(s1, low, 0.4),
    room(s1, low, deep),
    room(s1, high, deep),
    room(s1, high, 0.4),
    ROOM_WALL,
  );
  // The wall's back on either side of the doorway and above it, from inside.
  inside(
    room(s0, low, 0.4),
    room(DOORWAY[0], low, 0.4),
    room(DOORWAY[0], high, 0.4),
    room(s0, high, 0.4),
    ROOM_WALL,
  );
  inside(
    room(DOORWAY[1], low, 0.4),
    room(s1, low, 0.4),
    room(s1, high, 0.4),
    room(DOORWAY[1], high, 0.4),
    ROOM_WALL,
  );
  inside(
    room(DOORWAY[0], DOORWAY_HEAD, 0.4),
    room(DOORWAY[1], DOORWAY_HEAD, 0.4),
    room(DOORWAY[1], high, 0.4),
    room(DOORWAY[0], high, 0.4),
    ROOM_WALL,
  );
  wallBox(set, front, 12.4, 15.6, low, 1.1, -3.5, -2.9, COUNTER);
  wallBox(set, front, 12.3, 15.7, 1.1, 1.16, -3.56, -2.84, ROOM_FLOOR);
  wallBox(set, front, 12.2, 15.8, 1.75, 1.8, -deep + 0.02, -deep + 0.3, COUNTER);
  wallBox(set, front, 12.2, 15.8, 2.3, 2.35, -deep + 0.02, -deep + 0.3, COUNTER);
  for (let i = 0; i < 22; i++) {
    const s = 12.35 + (i % 11) * 0.31;
    const shelf = i < 11 ? 1.8 : 2.35;
    wallBox(
      set,
      front,
      s,
      s + 0.09,
      shelf,
      shelf + 0.26 + 0.05 * (i % 3),
      -deep + 0.08,
      -deep + 0.17,
      BOTTLES[i % 4],
    );
  }

  yield;

  // Above the awning's line: the balcony, its doors and the floor over it.
  const doors = [10.6, 13.6, 16.6, 19.6, 22.4];
  const near = [1.7, 4.5, 7.3];
  wall(
    set,
    front,
    line,
    ROOF,
    [
      ...doors.map((s, i) =>
        shuttered(
          s,
          line + 0.14,
          line + 2.45,
          i % 2 === 1 ? WARM_PANE : DARK_PANE,
          SHUTTER_GREEN,
          1.2,
        ),
      ),
      ...near.map((s) => shuttered(s, 5.2, 6.9, DARK_PANE, SHUTTER_BLUE)),
      ...[...near, ...doors].map((s, i) =>
        shuttered(
          s,
          8.4,
          10,
          i === 4 ? WARM_PANE : DARK_PANE,
          i % 2 ? SHUTTER_GREEN : SHUTTER_BLUE,
        ),
      ),
    ],
    UPPER,
    0.7,
  );
  yield;
  wallBox(set, front, -0.3, long, ROOF - 0.35, ROOF, 0, 0.35, UPPER_TRIM, [4]);
  wallBox(set, front, 8.9, long, line, line + 0.12, 0, 0.95, BALCONY, [4]);
  const rail = (s: number, proud: number): Vec3 => wallPoint(front, s, line + 0.12, proud);
  railing(set, rail(8.95, 0.9), rail(long - 0.05, 0.9), 0.95, IRON);
  railing(set, rail(8.95, 0.05), rail(8.95, 0.9), 0.95, IRON, 0.16);
  // The scroll brackets that stand out over the terrace, by the pier and near the wing.
  bracket(set, front, 9.6, 1.78, 0.75);
  bracket(set, front, 22.5, 2, 1.4);

  yield;

  // The end wall on the square, behind the painter's left shoulder.
  const depth = 8;
  const backNear = wallPoint(front, 0, 0, -depth);
  const backFar = wallPoint(front, long, 0, -depth);
  const end = wallFrame(backNear, front.origin);
  wall(
    set,
    end,
    0,
    ROOF,
    [
      { ...bay(4.3, 7.3) },
      {
        s0: 1.5,
        s1: 2.6,
        y0: 0,
        y1: 2.3,
        depth: 0.25,
        pane: NAVY,
        frame: { paint: WOOD, width: 0.12, proud: 0.06 },
      },
      shuttered(2.1, 5.2, 6.9, DARK_PANE, SHUTTER_BLUE),
      shuttered(5.7, 5.2, 6.9, WARM_PANE, SHUTTER_BLUE),
      shuttered(2.1, 8.4, 10, DARK_PANE, SHUTTER_GREEN),
      shuttered(5.7, 8.4, 10, DARK_PANE, SHUTTER_GREEN),
    ],
    UPPER,
    0.7,
  );
  wallBox(set, end, 3.9, depth + 0.3, 2.86, 3.4, 0, 0.3, WOOD, [4]);
  wallBox(set, end, 3.8, depth + 0.42, 3.4, 3.5, 0, 0.42, WOOD_PALE, [4]);
  wallBox(set, end, 3.9, depth, 0, 0.69, 0, 0.06, WOOD, [4]);
  wallBox(set, end, -0.3, depth + 0.35, ROOF - 0.35, ROOF, 0, 0.35, UPPER_TRIM, [4]);
  wall(set, wallFrame(backFar, backNear), 0, ROOF, [], UPPER, 3);
  const eave = (p: Vec3): Vec3 => [p[0], ROOF, p[2]];
  roof(
    set,
    [
      eave(wallPoint(front, -0.3, 0, 0.4)),
      eave(wallPoint(front, -0.3, 0, -depth - 0.3)),
      eave(wallPoint(front, long, 0, -depth - 0.3)),
      eave(wallPoint(front, long, 0, 0.4)),
    ],
    1.7,
    TILES,
    0.06,
  );
}

function awning(set: PaintBuilder): void {
  const [nearWall, nearOuter, farOuter, farWall] = AWNING;
  const below: Vec3 = [-1, -50, -13];
  const lift = (p: Vec3, y: number): Vec3 => [p[0], p[1] + y, p[2]];
  set.quad(nearWall, nearOuter, farOuter, farWall, CANVAS, { toward: below, cell: 0.4 });
  set.quad(
    lift(nearWall, 0.03),
    lift(nearOuter, 0.03),
    lift(farOuter, 0.03),
    lift(farWall, 0.03),
    CANVAS_TOP,
    { away: below, cell: 1 },
  );
  // Its frame: a bar along each edge and a rafter every few metres.
  beam(set, lift(nearOuter, -0.03), lift(farOuter, -0.03), 0.045, 0.045, RAFTER);
  beam(set, lift(nearWall, -0.03), lift(farWall, -0.03), 0.045, 0.045, RAFTER);
  for (let i = 0; i <= 6; i++) {
    const high = lift(mix(nearWall, farWall, i / 6), -0.035);
    const low = lift(mix(nearOuter, farOuter, i / 6), -0.035);
    beam(set, high, low, 0.03, 0.035, RAFTER);
  }
  // The valance: a strip along the outer edge and the near end, scalloped along its foot.
  const fringe = (a: Vec3, b: Vec3, side: Vec3): void => {
    const count = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.32));
    for (let i = 0; i < count; i++) {
      const p = mix(a, b, i / count);
      const q = mix(a, b, (i + 1) / count);
      const toward = add(mix(p, q, 0.5), side);
      sheet(set, [p, q, lift(q, -0.17), lift(p, -0.17)], CANVAS, CANVAS, toward);
      const tip = lift(mix(p, q, 0.5), -0.29);
      set.triangle(lift(p, -0.17), lift(q, -0.17), tip, CANVAS, { toward });
      set.triangle(lift(p, -0.17), lift(q, -0.17), tip, CANVAS, { away: toward });
    }
  };
  fringe(nearOuter, farOuter, [6, 0, 0]);
  fringe(nearWall, nearOuter, [0, 0, 6]);
}

/**
 * A wrought-iron bracket standing out from a wall: an arm `reach` long at height `y`, a scroll
 * curled under its end and a curved brace back to the wall.
 */
function bracket(set: PaintBuilder, frame: WallFrame, s: number, y: number, reach: number): void {
  const at = (out: number, up: number): Vec3 => wallPoint(frame, s, y + up, out);
  beam(set, at(0, 0), at(reach, 0), 0.03, 0.03, RED_IRON);
  wallBox(set, frame, s - 0.05, s + 0.05, y - 0.5, y + 0.12, 0, 0.02, RED_IRON, [4]);
  const curl = (
    cx: number,
    cy: number,
    r0: number,
    r1: number,
    from: number,
    turns: number,
  ): void => {
    let last: Vec3 | null = null;
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const angle = from + turns * 2 * Math.PI * t;
      const radius = r0 + (r1 - r0) * t;
      const point = at(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
      if (last) beam(set, last, point, 0.022, 0.022, RED_IRON);
      last = point;
    }
  };
  curl(reach - 0.15, -0.15, 0.15, 0.03, Math.PI / 2, -1.3);
  const brace = Math.min(0.45, reach * 0.5);
  curl(brace, -brace, brace, brace, Math.PI, -0.25);
  curl(0.09, -brace - 0.09, 0.09, 0.025, Math.PI / 2, 1.2);
}

/** The carriage and horse standing at the street's far end, its two lamps lit. */
function carriage(set: PaintBuilder): void {
  const [cx, cz] = [1.1, -44];
  const coat = (tint: number, lit = false): Paint =>
    paint(ID.carriage, SWATCH.dark, tint, { painted: false, lit });
  const coach = coat(0x1b3440);
  const dark = coat(0x10161f);
  const hide = coat(0x6f7a45);
  const lamp = coat(0xf2c84a, true);
  const block = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    p: Paint,
  ): void => box(set, [cx + x - w / 2, y, cz + z - d / 2], [w, 0, 0], [0, h, 0], [0, 0, d], p);
  block(0, 0.75, -1.2, 1.4, 1.25, 2, coach);
  block(0, 2, -1.2, 1.5, 0.08, 2.1, dark);
  block(0, 1.3, 0.1, 1.2, 0.45, 0.5, dark);
  block(0, 1.75, 0.15, 0.45, 0.75, 0.35, dark);
  for (const side of [-1, 1]) {
    block(side * 0.8, 1.5, -0.1, 0.16, 0.28, 0.16, lamp);
    for (const z of [-1.95, -0.35]) {
      const hub: Vec3 = [cx + side * 0.76, 0.55, cz + z];
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const b = ((i + 1) * Math.PI) / 6;
        const rim = (angle: number): Vec3 => [
          hub[0],
          hub[1] + 0.55 * Math.sin(angle),
          hub[2] + 0.55 * Math.cos(angle),
        ];
        beam(set, rim(a), rim(b), 0.06, 0.05, dark);
        if (i % 3 === 0) beam(set, hub, rim(a), 0.04, 0.04, dark);
      }
    }
    // The shafts and the horse's legs.
    beam(
      set,
      [cx + side * 0.34, 1, cz + 0.2],
      [cx + side * 0.34, 1.05, cz + 2.9],
      0.05,
      0.05,
      dark,
    );
    block(side * 0.17, 0, 1.6, 0.13, 1, 0.13, hide);
    block(side * 0.17, 0, 2.75, 0.13, 1, 0.13, hide);
  }
  block(0, 0.95, 2.15, 0.52, 0.62, 1.5, hide);
  block(0, 1.4, 2.95, 0.3, 0.75, 0.36, hide);
  block(0, 1.95, 3.25, 0.24, 0.3, 0.58, hide);
}

function rearWing(set: PaintBuilder): void {
  const left: Vec3 = [REAR_LEFT_X, 0, REAR_Z];
  const right: Vec3 = [REAR_RIGHT[0], 0, REAR_Z];
  const front = wallFrame(left, right);
  const top = REAR_RIGHT[1];
  const window = (s0: number, s1: number, y0: number, y1: number, pane: Paint): Opening => ({
    s0,
    s1,
    y0,
    y1,
    depth: 0.2,
    pane,
    bars: { paint: WING, across: 1, up: 2 },
    sill: WING,
  });
  wall(
    set,
    front,
    0,
    top,
    [
      {
        s0: 1.69,
        s1: 3.02,
        y0: DECK_HEIGHT,
        y1: 2.11,
        depth: 0.2,
        pane: WING_DOOR,
        bars: { paint: DOOR_FRAME, across: 1, up: 3 },
        frame: { paint: DOOR_FRAME, width: 0.1, proud: 0.05 },
      },
      window(1.08, 2.28, 10.45, top - 0.1, WING_DARK),
      window(0.5, 1.5, 5.1, 6.7, WING_DARK),
      window(2.3, 3.3, 5.1, 6.7, WING_DARK),
      window(0.5, 1.5, 7.9, 9.5, WING_DARK),
      window(2.3, 3.3, 7.9, 9.5, WING_DARK),
    ],
    WING,
    0.4,
  );
  // The roof falls from the café's side to the street's.
  const crest = REAR_LEFT_TOP;
  set.triangle([left[0], top, REAR_Z], [right[0], top, REAR_Z], [left[0], crest, REAR_Z], WING, {
    toward: [0, top, 0],
  });
  const back = REAR_Z - REAR_DEPTH;
  const side = wallFrame(right, [right[0], 0, back]);
  wall(
    set,
    side,
    0,
    top,
    [
      {
        s0: 4,
        s1: 5,
        y0: 0,
        y1: 2.2,
        depth: 0.25,
        pane: WING_PANE,
        frame: { paint: WING_SIDE, width: 0.1, proud: 0.05 },
      },
      window(1.7, 2.7, 2.4, 3.9, WING_GLOW),
      window(6.4, 7.4, 2.4, 3.9, WING_PANE),
      ...[1.7, 4, 6.4].flatMap((s) => [
        window(s, s + 1, 5.6, 7.2, WING_PANE),
        window(s, s + 1, 8.6, 10.2, WING_PANE),
      ]),
    ],
    WING_SIDE,
    0.8,
  );
  wallBox(set, side, -0.2, REAR_DEPTH, top - 0.3, top, 0, 0.25, WING_SIDE, [4]);
  wall(set, wallFrame([right[0], 0, back], [left[0], 0, back]), 0, top, [], WING_SIDE, 3);
  set.triangle([left[0], top, back], [right[0], top, back], [left[0], crest, back], WING_SIDE, {
    toward: [0, top, back - 50],
  });
  set.quad(
    [left[0], ROOF, REAR_Z],
    [left[0], ROOF, back],
    [left[0], crest, back],
    [left[0], crest, REAR_Z],
    WING_SIDE,
    {
      toward: [-50, ROOF, REAR_Z],
    },
  );
  set.quad(
    [left[0], crest, REAR_Z + 0.3],
    [right[0] + 0.3, top - 0.1, REAR_Z + 0.3],
    [right[0] + 0.3, top - 0.1, back],
    [left[0], crest, back],
    TILES,
    { toward: [0, 500, back], cell: 3 },
  );
}

function streetPaints(id: number, tint: number, painted: boolean, green = false): BuildingPaints {
  return {
    wall: paint(id, SWATCH.plaster, tint, { painted }),
    roof: paint(id, SWATCH.dark, 0x141c3c, { painted }),
    // What stands in or on a wall is built, so it keeps its own colour: only the walls and roofs
    // take the painting's.
    lit: paint(id, SWATCH.wall, 0xf0b63c, { painted: false, lit: true }),
    dark: paint(id, SWATCH.dark, 0x0e1430, { painted: false }),
    trim: paint(id, SWATCH.plaster, 0x4a5f98, { painted: false }),
    shutter: paint(id, SWATCH.shutter, green ? 0x2c5f48 : 0x27406e, { painted: false }),
  };
}

/** The lit shop under the tall house on the right, and the street running on past it. */
function* street(set: PaintBuilder, random: () => number): Steps<void> {
  // The shop's front runs from its street corner out to the right, past the canvas's edge.
  const corner: Vec3 = [7.9, 0, -30.9];
  const along = unit([0.565, 0, 0.825]);
  const back = scale(unit([-0.076, 0, -0.997]), 7);
  const end = add(corner, scale(along, 11.6));
  const plan = (points: Vec3[]): [number, number][] => points.map(([x, , z]) => [x, z]);
  const shop = streetPaints(ID.shop, 0x35508f, true, true);
  const black = paint(ID.shop, SWATCH.dark, 0x10131f, { painted: false });
  const glass = paint(ID.shop, SWATCH.wall, 0xd9c24a, { painted: false, lit: true });
  const door = paint(ID.shop, SWATCH.shutter, 0x2f6b4c, { painted: false });
  const lit = (s0: number, s1: number, y0: number, y1: number): Opening => ({
    s0,
    s1,
    y0,
    y1,
    depth: 0.25,
    // The shop's doors are green, between its lit windows.
    pane: y0 < 1 ? door : glass,
    reveal: black,
    bars: { paint: black, across: 1, up: 2 },
    frame: { paint: black, width: 0.12, proud: 0.08 },
  });
  const fronts: Opening[] = [
    lit(0.34, 2.21, 1.3, 4),
    lit(2.45, 3.4, 0.1, 3.85),
    lit(3.96, 5, 1.3, 3.85),
    lit(5.3, 6.3, 1.3, 3.85),
    lit(6.7, 7.7, 0.1, 3.85),
    lit(8.1, 9.6, 1.3, 3.85),
    lit(10, 11.2, 1.3, 3.85),
  ];
  for (const sill of [6.5, 9.4, 12.3, 15]) {
    for (const s of [1.3, 3.6, 5.9, 8.2, 10.4]) {
      fronts.push({
        s0: s - 0.5,
        s1: s + 0.5,
        y0: sill,
        y1: sill + 1.7,
        depth: 0.22,
        pane: shop.dark,
        bars: { paint: shop.trim, across: 1, up: 2 },
        sill: shop.trim,
        shutters: random() < 0.5 ? shop.shutter : undefined,
      });
    }
  }
  building(
    set,
    {
      plan: plan([corner, end, add(end, back), add(corner, back)]),
      height: 17.5,
      rise: 2,
      paints: shop,
      floors: [2.4, 6.5, 9.4, 12.3, 15],
      openings: { 0: fronts },
      blind: [1, 2],
      chimneys: 3,
      cell: 1.2,
    },
    random,
  );
  yield;
  const face = wallFrame(corner, end);
  wallBox(set, face, -0.1, 11.7, 4.05, 5.3, 0, 0.3, black, [4]);
  wallBox(set, face, -0.05, 11.65, 0, 1.25, 0, 0.1, black, [4]);

  // The darker house beyond it, on the same side of the street.
  const next = add(corner, back);
  const far = add(next, back);
  const width: Vec3 = [6.5, 0, -0.5];
  building(
    set,
    {
      plan: plan([next, far, add(far, width), add(next, width)]),
      height: 15.5,
      rise: 1.5,
      paints: streetPaints(ID.rightBlock, 0x1a2a60, true),
      floors: [2.6, 5.6, 8.6, 11.6],
      blind: [1, 2],
      chimneys: 2,
      cell: 1.5,
      lit: 0.3,
    },
    random,
  );
  yield;
  // The houses that close the street, and the tower behind them.
  const closing = streetPaints(ID.farStreet, 0x162252, true);
  building(
    set,
    {
      // An alley is left open at its left, where the street carries on.
      plan: [
        [1.1, -47],
        [4.7, -47],
        [4.7, -55],
        [1.1, -55],
      ],
      height: 11.4,
      rise: 1.5,
      paints: closing,
      floors: [2.4, 5.2, 8],
      blind: [1, 2],
      chimneys: 1,
      cell: 1.5,
      lit: 0.3,
    },
    random,
  );
  yield;
  building(
    set,
    {
      plan: [
        [4.7, -46.5],
        [7.8, -46.5],
        [7.8, -54],
        [4.7, -54],
      ],
      height: 14.3,
      rise: 1.2,
      paints: closing,
      floors: [2.6, 5.6, 8.6, 11.4],
      blind: [1, 2],
      chimneys: 1,
      cell: 1.5,
      lit: 0.3,
    },
    random,
  );
  yield;
  // The house the alley runs up to.
  building(
    set,
    {
      plan: [
        [-8, -59],
        [3, -59],
        [3, -65],
        [-8, -65],
      ],
      height: 12,
      rise: 1.4,
      paints: streetPaints(ID.farStreet, 0x121c46, false),
      floors: [2.4, 5.2, 8],
      blind: [1, 2, 3],
      cell: 2,
      lit: 0.3,
      detail: false,
    },
    random,
  );
  box(set, [4.4, 0, -57.6], [1.6, 0, 0], [0, 16.2, 0], [0, 0, 1.6], closing.wall, [2], 2);
  roof(
    set,
    [
      [4.3, 16.2, -55.9],
      [6.1, 16.2, -55.9],
      [6.1, 16.2, -57.7],
      [4.3, 16.2, -57.7],
    ],
    1.6,
    closing.roof,
    0.5,
  );
  // The left side of the street, beyond the wing: unseen from the painter's spot.
  building(
    set,
    {
      plan: [
        [-0.6, -31],
        [-0.6, -46.9],
        [-8, -46.9],
        [-8, -31],
      ],
      height: 10.5,
      rise: 1.4,
      paints: streetPaints(ID.farStreet, 0x21356e, true, true),
      floors: [2.4, 5.2],
      blind: [1, 2],
      chimneys: 2,
      cell: 1.5,
      lit: 0.35,
    },
    random,
  );
  yield;
}

/** The square behind and beside the painter: houses that close every view off the canvas. */
function* square(set: PaintBuilder, random: () => number): Steps<void> {
  const houses: readonly [Building['plan'], number, number, boolean][] = [
    [
      [
        [14.4, -21.4],
        [19.6, -13.9],
        [26, -18.3],
        [20.9, -25.9],
      ],
      13,
      0x24386f,
      false,
    ],
    [
      [
        [19.6, -13.5],
        [20, -1],
        [28, -1],
        [28, -13.5],
      ],
      15,
      0x2d4a86,
      true,
    ],
    [
      [
        [20, -0.6],
        [19, 11],
        [27, 11],
        [28, -0.6],
      ],
      12,
      0x1d2b5a,
      false,
    ],
    [
      [
        [4.4, 13],
        [18.6, 12.6],
        [18.6, 21],
        [4.4, 21],
      ],
      15,
      0x2a4480,
      true,
    ],
    [
      [
        [-9, 13],
        [4, 13],
        [4, 21],
        [-9, 21],
      ],
      12.5,
      0x1f3168,
      false,
    ],
    [
      [
        [-24, 12.6],
        [-9.4, 12.6],
        [-9.4, 20],
        [-24, 20],
      ],
      14,
      0x304c8a,
      true,
    ],
    [
      [
        [-25, 12],
        [-25, -8],
        [-32, -8],
        [-32, 12],
      ],
      13,
      0x223770,
      false,
    ],
  ];
  for (const [plan, height, tint, green] of houses) {
    building(
      set,
      {
        plan,
        height,
        rise: 1.2 + random(),
        paints: streetPaints(ID.enclosure, tint, true, green),
        floors: [2.5, 5.5, 8.5, 11.2],
        chimneys: 2,
        cell: 1.5,
        lit: 0.38,
      },
      random,
    );
    yield;
  }
}

/** Everything that stands still: the ground, the café, the street and the square. */
export function* buildSet(set: PaintBuilder, random: () => number): Steps<void> {
  ground(set);
  yield;
  yield* cafe(set);
  yield;
  awning(set);
  yield;
  rearWing(set);
  carriage(set);
  yield;
  yield* street(set, random);
  yield* square(set, random);
}
