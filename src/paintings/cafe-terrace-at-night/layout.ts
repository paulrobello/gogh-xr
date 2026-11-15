/**
 * The café set, measured off the scan: every surface is a canvas outline cast through the painter's
 * camera (canvas.ts) onto the plane it lies on, so from the painter's spot each silhouette lands on
 * its own paint. Canvas points are fractions of the scan, v down. Pure data, no WebGL.
 */
import type { WalkBounds } from '../../locomotion/walk-bounds';
import type { Vec3 } from '../../render/strokes/frame';
import { canvasRay, onFrontal, onLevel, onPlane, STREET_VANISH } from './canvas';

/** A patch of the scan that paints a surface where the projection cannot reach it. */
export interface Swatch {
  /** Canvas rectangle: u, v, width, height. */
  readonly rect: readonly [number, number, number, number];
  /** The patch's size on the surface, metres. */
  readonly metres: readonly [number, number];
}

export const SWATCH = {
  cobbles: { rect: [0.22, 0.86, 0.73, 0.13], metres: [3, 1.6] },
  wall: { rect: [0.395, 0.165, 0.095, 0.04], metres: [2.4, 1] },
  dark: { rect: [0.63, 0.33, 0.13, 0.19], metres: [5, 7] },
  awning: { rect: [0.3, 0.31, 0.22, 0.13], metres: [3, 3] },
  sky: { rect: [0.52, 0.0, 0.24, 0.22], metres: [1, 1] },
  foliage: { rect: [0.8, 0.14, 0.18, 0.2], metres: [2.4, 2.4] },
  shop: { rect: [0.77, 0.45, 0.22, 0.14], metres: [7, 5] },
} as const satisfies Record<string, Swatch>;

/** Paint ids: the painter's id map names the nearest surface under each canvas point. */
export const ID = {
  sky: 0,
  ground: 1,
  facade: 2,
  rearWing: 3,
  rearSide: 4,
  awning: 5,
  farStreet: 6,
  rightBlock: 7,
  rightSide: 8,
  shop: 9,
  shopSide: 10,
  enclosure: 11,
  trunk: 12,
  canopy: 13,
  lamp: 14,
  /** Tables, chairs and people count up from here, one id each. */
  props: 20,
} as const;

export interface SetSurface {
  readonly name: string;
  readonly id: number;
  /** A convex outline, in order. */
  readonly corners: readonly Vec3[];
  readonly swatch: Swatch;
}

/** The café façade's own vanishing point: it runs about 7° off the terrace's outer edge. */
const FACADE_VANISH_U = 0.375;
/** The façade's base at the terrace's front-left corner. */
const FACADE_ANCHOR = onLevel(0.145, 0.775);
const FACADE_DIRECTION: Vec3 = (() => {
  const [x, , z] = canvasRay(FACADE_VANISH_U, STREET_VANISH[1]);
  const length = Math.hypot(x, z);
  return [x / length, 0, z / length];
})();
const FACADE_NORMAL: Vec3 = [-FACADE_DIRECTION[2], 0, FACADE_DIRECTION[0]];

/** The façade's x where it crosses world `z`. */
export function facadeX(z: number): number {
  return FACADE_ANCHOR[0] + (FACADE_DIRECTION[0] * (z - FACADE_ANCHOR[2])) / FACADE_DIRECTION[2];
}

function onFacade(u: number, v: number): Vec3 {
  return onPlane(u, v, FACADE_ANCHOR, FACADE_NORMAL);
}

/** The building corner beside the painter, where the façade ends. */
export const NEAR_Z = 2.5;
/** The wing that closes the terrace: its lit wall stands on this plane. */
export const REAR_Z: number = onLevel(0.4, 0.615)[2];
const FAR_Z = -48;
const RIGHT_Z = -36;
const SHOP_Z: number = onLevel(0.76, 0.597)[2];
const BACK_Z = 9;
const SIDE_X = 18;
const CROSS_X = -24;
const ROOF = 16;

/** One stretch of a skyline on a frontal plane: the top runs from (u0, v0) to (u1, v1). */
type Skyline = readonly [u0: number, v0: number, u1: number, v1: number];

function frontalBlock(
  name: string,
  id: number,
  z: number,
  skyline: readonly Skyline[],
  swatch: Swatch,
): SetSurface[] {
  return skyline.map(([u0, v0, u1, v1], i) => {
    const left = onFrontal(u0, v0, z);
    const right = onFrontal(u1, v1, z);
    return {
      name: `${name} ${i}`,
      id,
      corners: [[left[0], 0, z], [right[0], 0, z], right, left],
      swatch,
    };
  });
}

function wall(
  name: string,
  id: number,
  a: Vec3,
  b: Vec3,
  height: number,
  swatch: Swatch,
): SetSurface {
  return {
    name,
    id,
    corners: [
      [a[0], 0, a[2]],
      [b[0], 0, b[2]],
      [b[0], height, b[2]],
      [a[0], height, a[2]],
    ],
    swatch,
  };
}

const AWNING_NEAR_WALL = onFacade(0.165, 0.152);
const AWNING_NEAR_OUTER = onFrontal(0.55, 0.335, AWNING_NEAR_WALL[2]);
const AWNING_FAR_OUTER = onFrontal(0.535, 0.505, REAR_Z);
const REAR_LEFT_X = facadeX(REAR_Z);
const REAR_RIGHT = onFrontal(0.5, 0.145, REAR_Z);
const REAR_LEFT_TOP = onFrontal(0.34, 0.085, REAR_Z)[1];
const RIGHT_SIDE = onFrontal(0.695, 0.235, RIGHT_Z);
const SHOP_LEFT = onFrontal(0.76, 0.47, SHOP_Z);
const SHOP_END_X = onFrontal(1.5, 0.435, SHOP_Z)[0];

/** The awning's four corners: near wall, near outer, far outer, far wall. */
export const AWNING: readonly [Vec3, Vec3, Vec3, Vec3] = [
  AWNING_NEAR_WALL,
  AWNING_NEAR_OUTER,
  AWNING_FAR_OUTER,
  [REAR_LEFT_X + 0.02, AWNING_NEAR_WALL[1], REAR_Z + 0.02],
];

export function cafeSet(): SetSurface[] {
  return [
    {
      name: 'ground',
      id: ID.ground,
      corners: [
        [CROSS_X, 0, BACK_Z],
        [SIDE_X + 30, 0, BACK_Z],
        [SIDE_X + 30, 0, FAR_Z],
        [CROSS_X, 0, FAR_Z],
      ],
      swatch: SWATCH.cobbles,
    },
    wall(
      'facade',
      ID.facade,
      [facadeX(NEAR_Z), 0, NEAR_Z],
      [REAR_LEFT_X, 0, REAR_Z],
      ROOF,
      SWATCH.wall,
    ),
    {
      name: 'rear wing',
      id: ID.rearWing,
      corners: [
        [REAR_LEFT_X, 0, REAR_Z],
        [REAR_RIGHT[0], 0, REAR_Z],
        REAR_RIGHT,
        [REAR_LEFT_X, REAR_LEFT_TOP, REAR_Z],
      ],
      swatch: SWATCH.wall,
    },
    wall(
      'rear wing side',
      ID.rearSide,
      [REAR_RIGHT[0], 0, REAR_Z],
      [REAR_RIGHT[0], 0, REAR_Z - 9],
      REAR_RIGHT[1],
      SWATCH.dark,
    ),
    { name: 'awning', id: ID.awning, corners: AWNING, swatch: SWATCH.awning },
    ...frontalBlock(
      'far street',
      ID.farStreet,
      FAR_Z,
      [
        [0.4, 0.37, 0.605, 0.37],
        [0.605, 0.37, 0.612, 0.3],
        [0.612, 0.3, 0.62, 0.27],
        [0.62, 0.27, 0.63, 0.3],
        [0.63, 0.3, 0.635, 0.315],
        [0.635, 0.315, 0.695, 0.315],
      ],
      SWATCH.dark,
    ),
    ...frontalBlock(
      'right block',
      ID.rightBlock,
      RIGHT_Z,
      [
        [0.695, 0.235, 0.775, 0.235],
        [0.775, 0.14, 0.81, 0.14],
        [0.81, 0.06, 0.845, 0.06],
        [0.845, -0.12, 1.6, -0.12],
      ],
      SWATCH.dark,
    ),
    wall(
      'right block side',
      ID.rightSide,
      [RIGHT_SIDE[0], 0, RIGHT_Z],
      [RIGHT_SIDE[0], 0, FAR_Z],
      RIGHT_SIDE[1],
      SWATCH.dark,
    ),
    ...frontalBlock(
      'shop',
      ID.shop,
      SHOP_Z,
      [
        [0.76, 0.47, 0.84, 0.47],
        [0.84, 0.435, 1.5, 0.435],
      ],
      SWATCH.shop,
    ),
    wall(
      'shop side',
      ID.shopSide,
      [SHOP_LEFT[0], 0, SHOP_Z],
      [SHOP_LEFT[0], 0, RIGHT_Z],
      SHOP_LEFT[1],
      SWATCH.dark,
    ),
    {
      name: 'shop roof',
      id: ID.shopSide,
      corners: [
        [SHOP_LEFT[0], SHOP_LEFT[1], SHOP_Z],
        [SHOP_END_X, SHOP_LEFT[1], SHOP_Z],
        [SHOP_END_X, SHOP_LEFT[1], RIGHT_Z],
        [SHOP_LEFT[0], SHOP_LEFT[1], RIGHT_Z],
      ],
      swatch: SWATCH.dark,
    },
    wall('square side', ID.enclosure, [SIDE_X, 0, BACK_Z], [SIDE_X, 0, RIGHT_Z], ROOF, SWATCH.dark),
    wall('square back', ID.enclosure, [CROSS_X, 0, BACK_Z], [SIDE_X, 0, BACK_Z], ROOF, SWATCH.dark),
    wall('cross end', ID.enclosure, [CROSS_X, 0, NEAR_Z], [CROSS_X, 0, BACK_Z], ROOF, SWATCH.dark),
  ];
}

/** Table height, metres. The painted tables are squat; this keeps their tops on their paint. */
export const TABLE_HEIGHT = 0.62;
export const SEAT_HEIGHT = 0.44;

export interface TableSpot {
  /** The top's centre. */
  readonly center: Vec3;
  readonly radius: number;
}

function table(u: number, v: number, width: number): TableSpot {
  const left = onLevel(u - width / 2, v, TABLE_HEIGHT);
  const right = onLevel(u + width / 2, v, TABLE_HEIGHT);
  return {
    center: onLevel(u, v, TABLE_HEIGHT),
    radius: Math.hypot(right[0] - left[0], right[2] - left[2]) / 2,
  };
}

/** Each painted tabletop: canvas centre and width. The last three stand out on the cobbles. */
export const TABLES: readonly TableSpot[] = [
  table(0.213, 0.73, 0.065),
  table(0.41, 0.728, 0.125),
  table(0.275, 0.675, 0.065),
  table(0.335, 0.642, 0.065),
  table(0.475, 0.648, 0.075),
  table(0.365, 0.622, 0.045),
  table(0.465, 0.603, 0.04),
  table(0.57, 0.635, 0.05),
  table(0.63, 0.662, 0.06),
  table(0.68, 0.685, 0.125),
];

export interface ChairSpot {
  /** The seat's centre. */
  readonly seat: Vec3;
  /** Radians: the way the sitter faces. */
  readonly yaw: number;
}

function chair(u: number, v: number, yaw: number): ChairSpot {
  return { seat: onLevel(u, v, SEAT_HEIGHT), yaw };
}

/** The empty chairs in the foreground and along the street edge. */
export const CHAIRS: readonly ChairSpot[] = [
  chair(0.325, 0.76, 2.6),
  chair(0.525, 0.757, -2.4),
  chair(0.265, 0.705, 0.6),
  chair(0.585, 0.75, -1.9),
  chair(0.455, 0.7, 0.3),
  chair(0.375, 0.69, -0.5),
  chair(0.615, 0.7, 1.2),
  chair(0.555, 0.675, -0.8),
];

export type Pose = 'standing' | 'seated' | 'server' | 'dress';

export interface PersonSpot {
  /** Where the feet, or the chair, stand. */
  readonly at: Vec3;
  readonly height: number;
  readonly yaw: number;
  readonly pose: Pose;
  /** Row of the scene's clothes table. */
  readonly outfit: number;
}

/** A standing figure from its painted feet and head top. */
function standing(
  u: number,
  feet: number,
  head: number,
  yaw: number,
  pose: Pose,
  outfit: number,
): PersonSpot {
  const horizon = STREET_VANISH[1];
  const painted = 1.6 * (1 - (head - horizon) / (feet - horizon));
  return {
    at: onLevel(u, feet),
    height: Math.min(1.8, Math.max(1.25, painted)),
    yaw,
    pose,
    outfit,
  };
}

const SEATED_HEAD = 1.12;

/** A seated figure from its painted head. */
function seated(u: number, head: number, yaw: number, outfit: number): PersonSpot {
  const [x, , z] = onLevel(u, head, SEATED_HEAD);
  return { at: [x, 0, z], height: 1.6, yaw, pose: 'seated', outfit };
}

export const PEOPLE: readonly PersonSpot[] = [
  standing(0.42, 0.663, 0.558, 0.2, 'server', 5),
  standing(0.245, 0.695, 0.595, 1.3, 'standing', 8),
  standing(0.635, 0.655, 0.58, 0.4, 'standing', 1),
  standing(0.722, 0.63, 0.54, -0.5, 'dress', 5),
  standing(0.75, 0.62, 0.54, -0.6, 'standing', 0),
  standing(0.675, 0.595, 0.54, 2.9, 'dress', 3),
  standing(0.7, 0.59, 0.535, 3.0, 'standing', 7),
  seated(0.285, 0.612, -1.2, 0),
  seated(0.375, 0.583, -0.6, 7),
  seated(0.392, 0.592, 0.9, 0),
  seated(0.455, 0.588, 1.4, 7),
  seated(0.47, 0.615, 2.2, 3),
  seated(0.525, 0.6, 1.9, 1),
];

/** The tree's foot on the cobbles, at the canvas's right edge. */
export const TRUNK: Vec3 = onLevel(0.985, 0.7);
/** The lantern under the awning. */
export const LAMP: Vec3 = onFrontal(0.39, 0.49, -13);

export const WALK_BOUNDS: WalkBounds = {
  minX: REAR_LEFT_X - 0.2,
  maxX: 6,
  minZ: SHOP_Z + 1.5,
  maxZ: 1.5,
  // Clears the rear wing's roofline while keeping the flight view inside the painted set.
  maxY: 16,
};

export interface SolidBox {
  readonly center: Vec3;
  readonly size: Vec3;
}

/** The buildings a walker or a teleport arc cannot enter, as boxes stepped along the façade. */
export function setSolids(): SolidBox[] {
  const solids: SolidBox[] = [];
  const step = 1.5;
  for (let z = NEAR_Z; z > REAR_Z; z -= step) {
    const end = Math.max(REAR_Z, z - step);
    const face = Math.max(facadeX(z), facadeX(end));
    const depth = 4;
    solids.push({
      center: [face - depth / 2, ROOF / 2, (z + end) / 2],
      size: [depth, ROOF, z - end],
    });
  }
  const wingWidth = REAR_RIGHT[0] - REAR_LEFT_X + 4;
  solids.push({
    center: [REAR_RIGHT[0] - wingWidth / 2, REAR_RIGHT[1] / 2, REAR_Z - 4.5],
    size: [wingWidth, REAR_RIGHT[1], 9],
  });
  solids.push({ center: [TRUNK[0], 1.7, TRUNK[2]], size: [0.4, 3.4, 0.4] });
  return solids;
}
