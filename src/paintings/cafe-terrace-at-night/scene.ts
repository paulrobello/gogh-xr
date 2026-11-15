import {
  type Box3,
  type BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Quaternion,
  RedFormat,
  type ShaderMaterial,
  SphereGeometry,
  type Texture,
  TubeGeometry,
  UnsignedByteType,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Raster } from '../../demo/canvas/field';
import type { Vec3 } from '../../render/strokes/frame';
import { mulberry32 } from '../../util/prng';
import type { Steps } from '../../util/slicer';
import { CANVAS_ASPECT, onFrontal, PAINTER_EYE } from './canvas';
import { rasterizeIds } from './id-map';
import {
  AWNING,
  CHAIRS,
  ID,
  LAMP,
  PEOPLE,
  SEAT_HEIGHT,
  SWATCH,
  setSolids,
  TABLE_HEIGHT,
  TABLES,
  TRUNK,
} from './layout';
import {
  createPaintMaterial,
  type Paint,
  type PaintBuilder,
  paintBuilder,
  painterView,
  type Swatch,
} from './paint';
import { createPeople } from './people';
import { scanSampler } from './scan';
import { buildSet } from './set';
import { solidBox } from './street';

/** The painter's id map, texels. The scan's aspect, tall enough to keep a chair leg. */
const ID_HEIGHT = 1024;
const ID_WIDTH = Math.round(ID_HEIGHT * CANVAS_ASPECT);
const SKY_RADIUS = 120;
/** Leaves tried through the crown; those that land on painted foliage stay. */
const LEAF_TRIES = 9000;
const CROWN_FORK = 3.2;
/** The crown's middle and half extents, metres: leaves stay inside it. */
const CROWN: Vec3 = [4.6, 5.9, -9.4];
const CROWN_REACH: Vec3 = [3.8, 3.1, 3.3];

const TABLETOP = 0xb7be97;
const IRON = 0x313c37;
const CANE = 0xa9743a;
const BARK = 0x1c2a36;
const LANTERN = 0xf5cd60;

/** A prop's paint: its own id, and its far side in its near side's colours. */
function prop(id: number, tint: number, more: Partial<Paint> = {}): Paint {
  return { id, swatch: SWATCH.plaster, tint, round: true, ...more };
}
/** Coat, hat, skin and accent for each outfit, for the sides the painter never saw. */
const CLOTHES = [
  [0x434846, 0x302e31, 0xb58e65, 0x7e7658],
  [0x998353, 0x6f5339, 0xb88b65, 0xbca478],
  [0x636d52, 0x3e4740, 0xc1a078, 0xb7a060],
  [0x77554a, 0x423638, 0xac795a, 0xb18b6e],
  [0x4d5c68, 0x363841, 0x946848, 0x7b8790],
  [0x9fa99b, 0x434950, 0xc39b74, 0xc4c8a5],
  [0x8a7050, 0x574936, 0xb28157, 0xafa583],
  [0x47403f, 0x343038, 0xa97855, 0x74634d],
  [0x343d31, 0x262b27, 0x746045, 0x594e37],
] as const;

export interface CafeCounts {
  readonly tables: number;
  readonly chairs: number;
  readonly people: number;
  readonly leaves: number;
  readonly triangles: number;
}

export interface CafeScene {
  readonly root: Group;
  readonly solids: readonly Box3[];
  readonly counts: CafeCounts;
  /** The painter's id map, which the paint material reads. */
  readonly ids: Texture;
  animate(time: number): void;
  dispose(): void;
}

function bentTubes(curves: readonly Vec3[][], radius: number): BufferGeometry {
  const tubes = curves.map(
    (points) =>
      new TubeGeometry(
        new CatmullRomCurve3(points.map((point) => new Vector3(...point))),
        points.length * 3,
        radius,
        6,
      ),
  );
  const frame = mergeGeometries(tubes);
  for (const tube of tubes) tube.dispose();
  return frame;
}

/** A bentwood chair: the sitter faces -Z, with the back hoop behind at +Z. */
function chairFrame(): BufferGeometry {
  return bentTubes(
    [
      [
        [-0.145, 0.02, 0.139],
        [-0.103, 0.428, 0.094],
        [-0.143, 0.66, 0.139],
        [-0.11, 0.78, 0.143],
        [0, 0.82, 0.147],
        [0.11, 0.78, 0.143],
        [0.143, 0.66, 0.139],
        [0.103, 0.428, 0.094],
        [0.145, 0.02, 0.139],
      ],
      [
        [-0.14, 0.02, -0.143],
        [-0.12, 0.24, -0.121],
        [-0.103, 0.426, -0.091],
      ],
      [
        [0.14, 0.02, -0.143],
        [0.12, 0.24, -0.121],
        [0.103, 0.426, -0.091],
      ],
      [
        [-0.139, 0.66, 0.139],
        [-0.07, 0.706, 0.132],
        [0.07, 0.706, 0.132],
        [0.139, 0.66, 0.139],
      ],
    ],
    0.017,
  );
}

/** Three splayed legs for a tabletop of radius 1 at height 1. */
function tableFrame(): BufferGeometry {
  const legs: Vec3[][] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (i * 2 * Math.PI) / 3 + 0.33;
    const point = (radius: number, y: number): Vec3 => [
      radius * Math.cos(angle),
      y,
      radius * Math.sin(angle),
    ];
    legs.push([point(0.64, 0.025), point(0.33, 0.32), point(0.46, 0.6), point(0.9, 0.97)]);
  }
  return bentTubes(legs, 0.03);
}

/** `scan` paints the set; `raster` is the same scan's pixels, for what the build reads off it. */
export function* buildCafeScene(seed: number, scan: Texture, raster: Raster): Steps<CafeScene> {
  const root = new Group();
  root.name = 'Café Terrace at Night';
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<ShaderMaterial>();
  const textures = new Set<Texture>();
  const dispose = (): void => {
    root.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    root.clear();
  };

  try {
    const solids: Box3[] = setSolids().map(({ center, size }) => solidBox(center, size));
    const transform = new Matrix4();
    const turn = new Quaternion();
    const scale = new Vector3();
    const UP = new Vector3(0, 1, 0);
    const placed = (at: Vec3, size: Vec3, yaw = 0): Matrix4 =>
      transform.compose(new Vector3(...at), turn.setFromAxisAngle(UP, yaw), scale.set(...size));

    const patches: Swatch[] = [];
    const set = paintBuilder(patches);
    yield* buildSet(set, mulberry32(seed + 7));
    yield;
    const cylinder = new CylinderGeometry(1, 1, 1, 14);
    const bark = new CylinderGeometry(0.68, 1, 1, 9);
    const trunk = prop(ID.trunk, BARK);
    set.mesh(bark, placed([TRUNK[0], CROWN_FORK / 2, TRUNK[2]], [0.2, CROWN_FORK, 0.2]), trunk);
    yield;

    // One id each, so a table's paint never lands on the chair behind it.
    const props = paintBuilder(patches);
    let id: number = ID.props;
    const table = tableFrame();
    const chair = chairFrame();
    for (const { center, radius } of TABLES) {
      const [x, , z] = center;
      props.mesh(
        cylinder,
        placed([x, TABLE_HEIGHT - 0.02, z], [radius, 0.04, radius]),
        prop(id, TABLETOP),
      );
      props.mesh(table, placed([x, 0, z], [radius, TABLE_HEIGHT, radius]), prop(id, IRON));
      solids.push(solidBox([x, TABLE_HEIGHT / 2, z], [radius * 1.8, TABLE_HEIGHT, radius * 1.8]));
      id++;
    }
    const seat = (at: Vec3, yaw: number): void => {
      props.mesh(chair, placed([at[0], 0, at[2]], [1, 1, 1], yaw), prop(id, CANE));
      props.mesh(
        cylinder,
        placed([at[0], SEAT_HEIGHT - 0.015, at[2]], [0.16, 0.03, 0.16]),
        prop(id, CANE),
      );
      solids.push(solidBox([at[0], 0.42, at[2]], [0.45, 0.84, 0.45]));
      id++;
    };
    for (const { seat: at, yaw } of CHAIRS) seat(at, yaw);
    yield;

    const stock = new MeshBasicMaterial();
    const people = createPeople(stock);
    try {
      for (const { at, height, yaw, pose, outfit } of PEOPLE) {
        // The figures face +Z, the chairs -Z.
        if (pose === 'seated') seat(at, yaw + Math.PI);
        const [coat, hat, skin, accent] = CLOTHES[outfit];
        const person = people.person({
          x: at[0],
          z: at[2],
          height,
          yaw,
          pose,
          coat,
          hat,
          skin,
          accent,
        });
        person.updateMatrix();
        const body = (person.children[0] as Mesh).geometry;
        props.mesh(body, person.matrix, prop(id++, 0x555555), { own: true });
        body.dispose();
        if (pose !== 'seated') {
          solids.push(solidBox([at[0], height / 2, at[2]], [0.39, height, 0.28]));
        }
        yield;
      }
    } finally {
      people.dispose();
      stock.dispose();
    }

    // A leaf stays only where the scan shows foliage, so the crown takes the painted outline, and
    // only inside the crown's own round, so it is a tree from every side.
    const crown = paintBuilder(patches);
    const random = mulberry32(seed + 31);
    const sample = scanSampler(raster);
    const leaf = new PlaneGeometry(0.36, 0.13);
    const lean = new Quaternion();
    const tilt = new Vector3();
    let leaves = 0;
    for (let i = 0; i < LEAF_TRIES; i++) {
      const u = 0.7 + random() * 0.6;
      const v = -0.02 + random() * 0.46;
      const z = CROWN[2] + (random() - 0.5) * 2 * CROWN_REACH[2];
      const turnZ = (random() - 0.3) * 1.5;
      tilt.set((random() - 0.5) * 0.8, (random() - 0.5) * 2.4, turnZ);
      const [r, g, b] = sample(u, v);
      // Foliage only: the scan's blue-green walls and sky pass a looser test and leave stray leaves.
      if (!(g > 38 && g > b * 1.12 && g > r * 1.02 && g - Math.max(r, b) > 10)) continue;
      const at = onFrontal(u, v, z);
      const round =
        ((at[0] - CROWN[0]) / CROWN_REACH[0]) ** 2 +
        ((at[1] - CROWN[1]) / CROWN_REACH[1]) ** 2 +
        ((at[2] - CROWN[2]) / CROWN_REACH[2]) ** 2;
      if (round > 1) continue;
      lean
        .setFromAxisAngle(UP, tilt.y)
        .multiply(turn.setFromAxisAngle(new Vector3(1, 0, 0), tilt.x));
      lean.multiply(turn.setFromAxisAngle(new Vector3(0, 0, 1), tilt.z));
      // Each leaf is one dab of the scan's green, darker toward the back of the crown.
      const depth =
        0.78 + 0.22 * Math.min(1, Math.max(0, (at[2] - CROWN[2]) / CROWN_REACH[2] + 0.5));
      const tint =
        (Math.round(Math.min(255, r * depth)) << 16) |
        (Math.round(Math.min(255, g * depth)) << 8) |
        Math.round(Math.min(255, b * depth));
      crown.mesh(leaf, transform.compose(new Vector3(...at), lean, scale.set(1, 1, 1)), {
        id: ID.canopy,
        swatch: SWATCH.foliage,
        tint,
        painted: false,
        lit: true,
      });
      leaves++;
      if (i % 800 === 799) yield;
    }
    // Three boughs carry the crown out over the street.
    for (const [dx, dy, dz] of [
      [-1.5, 1.6, 0.2],
      [-0.5, 2.3, -0.6],
      [0.5, 1.5, 0.5],
      [1.6, 2, -1.2],
      [0.9, 2.4, 1.4],
    ]) {
      const reach = new Vector3(dx, dy, dz);
      const length = reach.length();
      crown.mesh(
        bark,
        transform.compose(
          new Vector3(TRUNK[0] + dx / 2, CROWN_FORK + dy / 2, TRUNK[2] + dz / 2),
          lean.setFromUnitVectors(UP, reach.normalize()),
          scale.set(0.09, length, 0.09),
        ),
        trunk,
      );
    }
    yield;

    // The lantern: six lit panes in an iron cage, hung from the awning's frame.
    const lamp = paintBuilder(patches);
    const glass = new CylinderGeometry(0.2, 0.15, 0.42, 6);
    const cap = new CylinderGeometry(0.04, 0.25, 0.16, 6);
    const lit = prop(ID.lamp, LANTERN, { lit: true });
    const cage = prop(ID.lamp, IRON);
    lamp.mesh(glass, placed(LAMP, [1, 1, 1]), lit);
    lamp.mesh(cap, placed([LAMP[0], LAMP[1] + 0.29, LAMP[2]], [1, 1, 1]), cage);
    lamp.mesh(cap, placed([LAMP[0], LAMP[1] - 0.25, LAMP[2]], [0.7, -0.5, 0.7]), cage);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 6;
      lamp.mesh(
        cylinder,
        placed(
          [LAMP[0] + 0.185 * Math.cos(a), LAMP[1], LAMP[2] + 0.185 * Math.sin(a)],
          [0.012, 0.44, 0.012],
        ),
        cage,
      );
    }
    // The rod reaches the awning, which falls from the wall to its outer edge.
    const [nearWall, nearOuter] = AWNING;
    const fall = (LAMP[0] - nearWall[0]) / (nearOuter[0] - nearWall[0]);
    const rod =
      nearWall[1] + (nearOuter[1] - nearWall[1]) * Math.min(1, Math.max(0, fall)) - LAMP[1];
    lamp.mesh(
      cylinder,
      placed([LAMP[0], LAMP[1] + 0.3 + rod / 2, LAMP[2]], [0.012, Math.max(0.1, rod - 0.3), 0.012]),
      cage,
    );

    const sky = paintBuilder(patches);
    const dome = new SphereGeometry(SKY_RADIUS, 48, 24);
    sky.mesh(
      dome,
      placed(PAINTER_EYE, [1, 1, 1]),
      { id: ID.sky, swatch: SWATCH.sky, tint: 0x173a7c, raw: true },
      { uvScale: [24, 12] },
    );
    for (const geometry of [cylinder, bark, table, chair, leaf, dome, glass, cap])
      geometry.dispose();
    yield;

    const parts = [set, props, crown, lamp];
    const total = parts.reduce((sum, part) => sum + part.positions.length, 0);
    const positions = new Float32Array(total);
    const owners = new Uint8Array(total / 3);
    let offset = 0;
    for (const part of parts) {
      // In slices: one part holds most of the set's triangles.
      const { positions: from, ids: named } = part;
      for (let i = 0; i < from.length; i++) {
        positions[offset + i] = from[i];
        if (i % 3 === 0) owners[(offset + i) / 3] = named[i / 3];
        if (i % 150_000 === 149_999) yield;
      }
      offset += from.length;
      yield;
    }
    const map = yield* rasterizeIds(positions, owners, ID_WIDTH, ID_HEIGHT, ID.sky);
    const ids = new DataTexture(map, ID_WIDTH, ID_HEIGHT, RedFormat, UnsignedByteType);
    ids.minFilter = NearestFilter;
    ids.magFilter = NearestFilter;
    ids.unpackAlignment = 1;
    ids.needsUpdate = true;
    textures.add(ids);

    const view = painterView(raster, map, ID_WIDTH, ID_HEIGHT);
    for (const part of [...parts, sky]) yield* part.bake(view);
    const material = createPaintMaterial(scan, ids, ID_WIDTH, ID_HEIGHT, patches, view);
    // Leaves, bent tubes and the dome, seen from inside, show both faces.
    const loose = createPaintMaterial(scan, ids, ID_WIDTH, ID_HEIGHT, patches, view, DoubleSide);
    const glow = loose.clone();
    materials.add(material).add(loose).add(glow);
    const show = function* (part: PaintBuilder, paint: ShaderMaterial): Steps<Mesh> {
      const geometry = yield* part.build();
      geometries.add(geometry);
      const mesh = new Mesh(geometry, paint);
      // Every part spans the street, and the paint needs each at its rest pose.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      return mesh;
    };
    root.add(yield* show(sky, loose));
    yield;
    root.add(yield* show(set, material));
    yield;
    root.add(yield* show(props, loose), yield* show(lamp, glow));
    yield;

    const canopy = yield* show(crown, loose);
    const canopyPivot = new Group();
    canopyPivot.position.set(TRUNK[0], CROWN_FORK, TRUNK[2]);
    canopy.position.copy(canopyPivot.position).negate();
    canopy.updateMatrix();
    canopyPivot.add(canopy);
    root.add(canopyPivot);

    return {
      root,
      solids,
      ids,
      counts: {
        tables: TABLES.length,
        chairs: CHAIRS.length + PEOPLE.filter(({ pose }) => pose === 'seated').length,
        people: PEOPLE.length,
        leaves,
        triangles: (total + sky.positions.length) / 9,
      },
      dispose,
      animate(time) {
        const phase = (time * Math.PI) / 5;
        canopyPivot.rotation.z = 0.028 * Math.sin(phase);
        canopyPivot.rotation.x = 0.016 * Math.sin(phase * 2);
        glow.uniforms.uGain.value = 1 + 0.075 * Math.sin(phase * 8) + 0.035 * Math.sin(phase * 13);
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
