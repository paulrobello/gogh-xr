import {
  type Box3,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
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
import { CANVAS_ASPECT, PAINTER_EYE } from './canvas';
import { rasterizeIds } from './id-map';
import {
  AWNING,
  BUILT,
  CHAIRS,
  ID,
  isProp,
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
const LEAVES = 2800;
const CROWN_FORK = 3.2;
/**
 * The crown's lobes, each a middle and half extents in metres, over where the scan paints the
 * foliage. Every leaf lies in one, so the tree is whole from every side.
 */
const CROWN: readonly (readonly [Vec3, Vec3])[] = [
  [
    [4.6, 6, -9.4],
    [2.6, 2, 2.4],
  ],
  [
    [2.9, 5.4, -9],
    [1.7, 1.4, 1.7],
  ],
  [
    [6.3, 5.5, -9.9],
    [1.8, 1.5, 1.8],
  ],
  [
    [4.4, 7.3, -9.6],
    [1.7, 1.2, 1.6],
  ],
  [
    [4.9, 4.6, -8.3],
    [1.6, 1, 1.5],
  ],
];

const TABLETOP = 0xb7be97;
const IRON = 0x313c37;
const CANE = 0xa9743a;
const BARK = 0x2a3838;
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
    // The scan shows almost nothing of the trunk, so it is bark all round.
    const trunk: Paint = { id: ID.trunk, swatch: SWATCH.wood, tint: BARK, painted: false };
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

    // The crown: leaves through each lobe, thicker toward its skin, each one dab of the scan's own
    // foliage, lighter on top and darker inside.
    const crown = paintBuilder(patches);
    const random = mulberry32(seed + 31);
    const sample = scanSampler(raster);
    const leaf = new BufferGeometry();
    leaf.setAttribute(
      'position',
      new Float32BufferAttribute([-0.2, 0, 0, 0, -0.075, 0, 0.2, 0, 0, 0, 0.075, 0], 3),
    );
    leaf.setIndex([0, 1, 2, 0, 2, 3]);
    const lean = new Quaternion();
    const out = new Vector3();
    const FLAT = new Vector3(0, 0, 1);
    const sizes = CROWN.map(([, reach]) => reach[0] * reach[1] * reach[2]);
    const whole = sizes.reduce((sum, size) => sum + size, 0);
    for (let i = 0; i < LEAVES; i++) {
      let pick = random() * whole;
      let lobe = 0;
      while (lobe < CROWN.length - 1 && pick > sizes[lobe]) pick -= sizes[lobe++];
      const [middle, reach] = CROWN[lobe];
      const turnY = random() * 2 * Math.PI;
      const rise = 2 * random() - 1;
      const level = Math.sqrt(1 - rise * rise);
      out.set(level * Math.cos(turnY), rise, level * Math.sin(turnY));
      const deep = 0.5 + 0.5 * Math.sqrt(random());
      const at = new Vector3(
        middle[0] + reach[0] * out.x * deep,
        middle[1] + reach[1] * out.y * deep,
        middle[2] + reach[2] * out.z * deep,
      );
      // A dab of foliage off the scan, tried a few times.
      let [r, g, b] = [47, 106, 58];
      for (let tries = 0; tries < 6; tries++) {
        const dab = sample(0.76 + random() * 0.23, 0.1 + random() * 0.28);
        if (dab[1] > 38 && dab[1] > dab[2] * 1.12 && dab[1] > dab[0] * 1.02) {
          [r, g, b] = dab;
          break;
        }
      }
      const shade = (0.62 + 0.38 * deep) * (0.82 + 0.18 * out.y);
      const tint =
        (Math.round(Math.min(255, r * shade)) << 16) |
        (Math.round(Math.min(255, g * shade)) << 8) |
        Math.round(Math.min(255, b * shade));
      out.x += (random() - 0.5) * 1.1;
      out.y += (random() - 0.5) * 1.1;
      out.z += (random() - 0.5) * 1.1;
      lean
        .setFromUnitVectors(FLAT, out.normalize())
        .multiply(turn.setFromAxisAngle(FLAT, random() * Math.PI));
      const size = 0.8 + random() * 0.7;
      crown.mesh(leaf, transform.compose(at, lean, scale.set(size, size, size)), {
        id: ID.canopy,
        swatch: SWATCH.foliage,
        tint,
        painted: false,
        lit: true,
      });
      if (i % 400 === 399) yield;
    }
    // A bough to each lobe.
    for (const [middle] of CROWN) {
      const reach = new Vector3(middle[0] - TRUNK[0], middle[1] - CROWN_FORK, middle[2] - TRUNK[2]);
      const length = reach.length();
      crown.mesh(
        bark,
        transform.compose(
          new Vector3(TRUNK[0], CROWN_FORK, TRUNK[2]).addScaledVector(reach, 0.5),
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
    const lit = prop(ID.lamp, LANTERN, { painted: false, lit: true });
    const cage = prop(ID.lamp, IRON);
    // As big as the scan paints it: about 0.7 m of glass.
    const big = 1.6;
    lamp.mesh(glass, placed(LAMP, [big, big, big]), lit);
    lamp.mesh(cap, placed([LAMP[0], LAMP[1] + 0.29 * big, LAMP[2]], [big, big, big]), cage);
    lamp.mesh(
      cap,
      placed([LAMP[0], LAMP[1] - 0.25 * big, LAMP[2]], [0.7 * big, -0.5 * big, 0.7 * big]),
      cage,
    );
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 6;
      lamp.mesh(
        cylinder,
        placed(
          [LAMP[0] + 0.185 * big * Math.cos(a), LAMP[1], LAMP[2] + 0.185 * big * Math.sin(a)],
          [0.016, 0.44 * big, 0.016],
        ),
        cage,
      );
    }
    // The rod reaches the awning, which falls from the wall to its outer edge.
    const [nearWall, nearOuter] = AWNING;
    const fall = (LAMP[0] - nearWall[0]) / (nearOuter[0] - nearWall[0]);
    const rod =
      nearWall[1] + (nearOuter[1] - nearWall[1]) * Math.min(1, Math.max(0, fall)) - LAMP[1];
    const hook = 0.3 * big;
    lamp.mesh(
      cylinder,
      placed(
        [LAMP[0], LAMP[1] + hook + rod / 2, LAMP[2]],
        [0.014, Math.max(0.1, rod - hook), 0.014],
      ),
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

    const view = painterView(raster, map, ID_WIDTH, ID_HEIGHT, {
      covers: isProp,
      ignore: BUILT,
      grow: 7,
    });
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
        leaves: LEAVES,
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
