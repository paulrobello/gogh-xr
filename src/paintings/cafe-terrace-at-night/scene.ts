import {
  type Box3,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RepeatWrapping,
  type Texture,
} from 'three';
import type { Vec3 } from '../../render/strokes/frame';
import { mulberry32 } from '../../util/prng';
import type { Steps } from '../../util/slicer';
import { solidBox } from './street';

const CAFE_WALL_X = -3.28;
const AMBER = 0xbd8732;
const TRIM = 0x313c37;
const INK = 0x1b2941;
const WINDOW = 0xe7b95a;
const SKY = 0x194984;
const COBBLES = [0x3d5676, 0x536278, 0x39475a, 0x687585, 0x435b81, 0x7d6c53];
const OCHRE = [0xa4763e, 0x9a6636, 0x8c754e, 0xb28b4d, 0x867754];

export interface CafeScene {
  readonly root: Group;
  readonly solids: readonly Box3[];
  dispose(): void;
}

function paintTexture(random: () => number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const paint = canvas.getContext('2d');
  if (!paint) throw new Error('The café paint texture needs a 2D canvas');
  paint.fillStyle = '#e1e1e1';
  paint.fillRect(0, 0, 256, 256);
  paint.lineCap = 'round';
  for (let i = 0; i < 1800; i++) {
    const x = random() * 256;
    const y = random() * 256;
    const length = 2 + random() * 20;
    paint.lineWidth = 1 + random() * 4;
    paint.strokeStyle = random() < 0.5 ? 'rgba(70,70,70,0.16)' : 'rgba(255,255,255,0.30)';
    paint.beginPath();
    paint.moveTo(x, y);
    paint.quadraticCurveTo(x + length * 0.45, y - 2, x + length, y + 2);
    paint.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

interface Mark {
  readonly center: Vec3;
  readonly size: Vec3;
  readonly color: number;
  readonly angle?: number;
}

function scatter(
  geometry: BufferGeometry,
  marks: readonly Mark[],
  flat: boolean,
): InstancedMesh<BufferGeometry, MeshBasicMaterial> {
  const mesh = new InstancedMesh(
    geometry,
    new MeshBasicMaterial({ toneMapped: false }),
    marks.length,
  );
  const transform = new Object3D();
  const tint = new Color();
  for (let i = 0; i < marks.length; i++) {
    const { center, size, color, angle = 0 } = marks[i];
    transform.position.set(...center);
    transform.scale.set(...size);
    transform.rotation.set(flat ? -Math.PI / 2 : 0, 0, angle);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
    mesh.setColorAt(i, tint.setHex(color));
  }
  return mesh;
}

export function* buildCafeScene(seed: number): Steps<CafeScene> {
  const random = mulberry32(seed);
  const root = new Group();
  root.name = 'Café Terrace at Night';
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<MeshBasicMaterial>();
  const textures = new Set<Texture>();
  const solids: Box3[] = [];
  const dispose = (): void => {
    root.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    for (const child of root.children) if (child instanceof InstancedMesh) child.dispose();
    root.clear();
  };

  try {
    const cube = new BoxGeometry();
    const cylinder = new CylinderGeometry(1, 1, 1, 12);
    const stamp = new CircleGeometry(1, 7);
    const leaves = new IcosahedronGeometry(1, 0);
    for (const geometry of [cube, cylinder, stamp, leaves]) geometries.add(geometry);
    const paint = paintTexture(random);
    textures.add(paint);
    const palette = new Map<number, MeshBasicMaterial>();
    const place = (
      geometry: BufferGeometry,
      center: Vec3,
      size: Vec3,
      color: number,
      zAngle = 0,
    ): Mesh => {
      let material = palette.get(color);
      if (!material) {
        material = new MeshBasicMaterial({ color, map: paint, toneMapped: false });
        palette.set(color, material);
        materials.add(material);
      }
      const mesh = new Mesh(geometry, material);
      mesh.position.set(...center);
      mesh.scale.set(...size);
      mesh.rotation.z = zAngle;
      root.add(mesh);
      return mesh;
    };
    const box = (center: Vec3, size: Vec3, color: number, angle = 0): Mesh =>
      place(cube, center, size, color, angle);
    const solid = (center: Vec3, size: Vec3, color: number): void => {
      box(center, size, color);
      solids.push(solidBox(center, size));
    };
    const addScatter = (geometry: BufferGeometry, marks: readonly Mark[], flat = false): void => {
      const mesh = scatter(geometry, marks, flat);
      materials.add(mesh.material);
      root.add(mesh);
    };

    // The café façade steps behind the blue shopfront. The right wall opens the view into the square.
    solid([CAFE_WALL_X - 2.5, 4.9, -3], [5, 9.8, 13.3], 0x56697c);
    box([CAFE_WALL_X + 0.02, 2.16, -3], [0.06, 4.32, 13.15], 0xb4923a);
    solid([-4, 4.7, 5.02], [4.7, 9.4, 4.76], 0x344d6c);
    box([-1.62, 2.1, 3.29], [0.1, 4.2, 1.18], INK);
    box([-1.56, 1.66, 3.29], [0.06, 2.96, 0.78], 0xc19442);
    box([-1.52, 1.64, 3.29], [0.05, 0.09, 0.86], 0x794329);
    box([-1.52, 3.56, 3.29], [0.24, 0.3, 1.46], 0x344d6c);
    box([-1.66, 2.18, 2.63], [0.24, 4.36, 0.12], 0x304965);

    for (const [x, z, width, length, height, color] of [
      [-5.9, -13.2, 4.5, 7.2, 8.4, 0x405370],
      [-4.5, -20.2, 5.7, 7.3, 9.3, 0x283a56],
      [6.1, -5.8, 4, 7.6, 9.4, 0x354867],
      [6.1, -11.1, 4, 5.4, 10.5, 0x253650],
      [5.15, -17.1, 4.1, 6.8, 7.7, 0x242d4b],
      [4.05, -23.3, 4.1, 5.8, 9.4, 0x1b2843],
      [1.55, -32.4, 9.2, 5, 7.4, 0x20324f],
    ] as const) {
      solid([x, height / 2, z], [width, height, length], color);
      const side = Math.sign(x);
      const face = x - (width / 2 + 0.035) * side;
      box([face, height - 0.14, z], [0.16, 0.26, length], color);
      for (const offset of [-0.29, 0.1, 0.32]) {
        const sill = z + length * offset;
        box([face, height * 0.55, sill], [0.12, 1.04, 0.47], INK);
        box([face - side * 0.069, height * 0.55, sill], [0.035, 0.83, 0.29], 0x8d7541);
      }
    }
    box([0.5, 8.3, -30], [0.95, 2.2, 1.25], INK);
    place(cylinder, [0.5, 9.7, -30], [0.22, 0.96, 0.22], INK);
    yield;

    // A solid sheet shows the painted fabric from below and the rolled hem from the street.
    const width = 2.91;
    const fall = 1.2;
    const tilt = -Math.atan2(fall, width);
    box([-1.84, 3.73, -3.01], [Math.hypot(width, fall), 0.1, 11.19], 0xd3a441, tilt);
    box([-0.385, 3.075, -3.01], [0.11, 0.19, 11.19], 0xa78b3d);
    box([-0.312, 3.12, -3.01], [0.055, 0.045, 11.19], 0x5b6641);
    for (const z of [-7.9, -4.8, -1.9, 1.3]) {
      box([-1.84, 3.665, z], [Math.hypot(width, fall), 0.045, 0.038], 0x8f6c30, tilt);
      box([CAFE_WALL_X + 0.042, 5.51, z], [0.085, 1.26, 0.86], INK);
      box([CAFE_WALL_X + 0.1, 5.51, z], [0.08, 1.21, 0.65], TRIM);
      for (let row = 0; row < 8; row++) {
        box([CAFE_WALL_X + 0.16, 5 + row * 0.14, z], [0.06, 0.045, 0.64], 0x55634e);
      }
      box([CAFE_WALL_X + 0.09, 1.48, z], [0.12, 2.56, 0.96], AMBER);
      box([CAFE_WALL_X + 0.165, 1.64, z], [0.045, 1.9, 0.74], WINDOW);
      box([CAFE_WALL_X + 0.202, 1.64, z], [0.04, 1.9, 0.046], 0xa37334);
    }
    box([-2.5, 2.79, -4.6], [0.09, 0.32, 0.09], 0x83602d);
    box([-2.5, 2.55, -4.6], [0.28, 0.32, 0.28], 0xf5cd60);
    box([-2.5, 2.75, -4.6], [0.32, 0.09, 0.32], AMBER);
    box([-2.5, 2.36, -4.6], [0.32, 0.07, 0.32], AMBER);

    box([4.02, 1.52, -5.18], [0.26, 2.96, 4.8], 0x263b39);
    for (const z of [-3.85, -4.9, -5.95, -7]) {
      box([3.86, 1.61, z], [0.095, 2.23, 0.83], z === -3.85 ? WINDOW : 0x9f914b);
      box([3.8, 1.71, z], [0.05, 0.07, 0.84], TRIM);
    }
    box([3.89, 2.99, -5.18], [0.42, 0.27, 4.9], INK);
    yield;

    box([0.5, -0.12, -16], [28, 0.2, 54], 0x384358);
    box([-1.82, -0.045, -2.97], [2.9, 0.068, 11.18], 0x886130);
    const stones: Mark[] = [];
    for (let row = 0; row < 158; row++) {
      for (let col = 0; col < 52; col++) {
        const x = -7.7 + (col + (row % 2) / 2) * 0.32 + random() * 0.085;
        const z = 8 - row * 0.27 + random() * 0.085;
        const terrace = x < -0.37 && z > -8.55 && z < 2.61;
        const spill = z > -12 && z < 3.8 && x < 1.7 && random() * 2.4 > x + 0.8;
        const colors = terrace || spill ? OCHRE : COBBLES;
        stones.push({
          center: [x, terrace ? -0.007 : -0.014, z],
          size: [0.1 + random() * 0.08, 0.075 + random() * 0.065, 1],
          angle: random() * 0.95 - 0.47,
          color: colors[Math.floor(random() * colors.length)],
        });
      }
      if (row % 40 === 39) yield;
    }
    addScatter(stamp, stones, true);
    for (const z of [-7.7, -5.4, -3.2, -0.9, 1.18]) {
      const x = z === -5.4 || z === -0.9 ? -2.49 : -1.53;
      place(cylinder, [x, 0.74, z], [0.43, 0.07, 0.37], 0xb9b587);
      place(cylinder, [x, 0.37, z], [0.043, 0.69, 0.043], TRIM);
      box([x, 0.075, z], [0.57, 0.065, 0.07], TRIM);
      solids.push(solidBox([x, 0.39, z], [0.8, 0.78, 0.71]));
      const chairZ = z + 0.64;
      box([x, 0.41, chairZ], [0.36, 0.07, 0.34], AMBER);
      box([x, 0.73, chairZ + 0.14], [0.33, 0.09, 0.045], AMBER);
      for (const dx of [-0.14, 0.14]) {
        box([x + dx, 0.405, chairZ + 0.14], [0.035, 0.81, 0.035], TRIM);
        box([x + dx, 0.2, chairZ - 0.13], [0.035, 0.4, 0.035], TRIM);
      }
      solids.push(solidBox([x, 0.405, chairZ], [0.36, 0.81, 0.34]));
    }
    yield;

    for (const [x, z, height, coat, hat] of [
      [-2.48, -6.88, 1.68, 0xb5bb99, 0x343732],
      [-1.76, -7.95, 1.3, 0x403f38, 0x31332c],
      [-1.18, -5.15, 1.27, 0x84603a, 0x553c2b],
      [1.15, -9.15, 1.68, 0x9d8645, 0x5b5537],
      [2.7, -11.8, 1.65, 0x444c5e, 0x35383e],
      [1.87, -14.2, 1.59, 0x784638, 0x534439],
    ] as const) {
      box([x, height * 0.54, z], [0.36, height * 0.45, 0.22], coat, 0.035);
      for (const side of [-1, 1]) {
        box([x + side * 0.09, height * 0.21, z], [0.1, height * 0.42, 0.11], TRIM, side * 0.055);
      }
      place(leaves, [x, height * 0.84, z], [0.126, 0.147, 0.11], 0xb38a5a);
      place(cylinder, [x, height * 0.94, z], [0.162, 0.05, 0.142], hat);
      solids.push(solidBox([x, height / 2, z], [0.36, height, 0.25]));
    }

    solid([4.25, 1.55, -3.2], [0.23, 3.1, 0.27], 0x424133);
    const foliage: Mark[] = [];
    const greens = [0x253c3a, 0x2d493c, 0x3d533c, 0x465a40, 0x526343];
    for (let i = 0; i < 140; i++) {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random());
      foliage.push({
        center: [
          4.05 + 2.9 * reach * Math.cos(angle),
          4.2 + random() * 2.25,
          -3.35 + 2.2 * reach * Math.sin(angle),
        ],
        size: [0.24 + random() * 0.49, 0.13 + random() * 0.29, 0.19 + random() * 0.4],
        angle: random() * Math.PI,
        color: greens[Math.floor(random() * greens.length)],
      });
    }
    addScatter(leaves, foliage);

    const skyMarks: Mark[] = [];
    for (let i = 0; i < 115; i++) {
      skyMarks.push({
        center: [-34 + random() * 68, 4 + random() * 38, -44],
        size: [0.8 + random() * 2.7, 0.3 + random() * 1.2, 1],
        angle: -0.35 + random() * 0.9,
        color: random() < 0.65 ? 0x1c4c88 : 0x1d508c,
      });
    }
    for (let i = 0; i < 70; i++) {
      const size = 0.07 + random() * 0.14;
      skyMarks.push({
        center: [-24 + random() * 49, 8 + random() * 29, -43.8],
        size: [size * 1.2, size, 1],
        color: random() < 0.8 ? 0x82909a : 0xbda96c,
      });
    }
    for (const [x, y, size] of [
      [-12, 25, 0.74],
      [-6, 16, 0.36],
      [2.2, 20.4, 0.56],
      [6.8, 28, 0.72],
      [5.7, 12.5, 0.36],
      [-1.6, 30, 0.25],
      [14, 32, 0.3],
      [10, 23, 0.32],
      [-10, 31.2, 0.29],
      [2.8, 9.3, 0.27],
      [-3, 11.8, 0.19],
      [2.5, 25.2, 0.21],
    ] as const) {
      skyMarks.push(
        { center: [x, y, -43.95], size: [size * 1.35, size * 1.11, 1], color: 0x577791 },
        {
          center: [x + size * 0.16, y, -43.9],
          size: [size * 0.61, size * 0.49, 1],
          color: 0xd6c988,
          angle: 0.35,
        },
        { center: [x, y, -43.85], size: [size * 0.29, size * 0.26, 1], color: 0xe8d79a },
      );
    }
    addScatter(stamp, skyMarks);
    return { root, solids, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export const CAFE_SKY: number = SKY;
