/**
 * The gallery's plaques (P5.4): a dark card edged in the moulding's gold beside each frame at 1.3 m,
 * with the title, the year and the museum in troika SDF text from the local NotoSans-Regular, plus
 * "Coming soon" in the wheat's gold on the paintings without a world. Hierarchy comes from size
 * and colour, since the one font has one weight. The detail block sits a fixed gap under the
 * title's typeset bottom, and the two are centred on the card as one block. The seven cards and
 * their edges are one merged mesh (one draw call) and each plaque two text meshes, the title and
 * the detail block, each culled on its own: a plaque in view costs two draw calls. Troika's
 * experimental `BatchedText` drew no glyphs here, so the lines stay separate.
 *
 * Sizes: the title is 30 mm and the detail lines 21 mm per em. At 1.5 m that is about 1.1° and
 * 0.8° per em, an x-height of 10-13 Quest 3 pixels; a 45° oblique narrows the glyphs by 0.71 but
 * keeps their height.
 */
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Text } from 'troika-three-text';
import { TEXT_FONT_URL } from '../../ui/troika-config';
import {
  type Hanging,
  PLAQUE_CENTRE_Y,
  PLAQUE_DEPTH,
  PLAQUE_HEIGHT,
  PLAQUE_WIDTH,
  wallPoint,
} from './layout';
import { PLAQUE_COLORS, type Rgb, underpaint } from './palette';

export const TITLE_SIZE = 0.03;
export const DETAIL_SIZE = 0.021;
const PAD = 0.026;
/** Between the title's last line and the year, metres. */
const BLOCK_GAP = 0.012;
/** The gold edge around each card, metres, and how far it sits behind the card's face. */
const EDGE = 0.006;
const EDGE_RECESS = 0.003;
/** In front of the card face, metres. */
const TEXT_LIFT = 0.0015;
/**
 * Depth priority over the wall strokes, in depth-buffer units: the stroke tie-break may move a wall
 * stroke up to 2048 steps toward the eye (src/render/strokes/depth-tie-break.ts), which from across
 * the room is more than the card's 12 mm. The text must out-rank the card it sits on, so it takes
 * troika's `depthOffset`, which overwrites its material's polygonOffset factor and units alike.
 */
export const CARD_DEPTH_UNITS = -2400;
const TEXT_DEPTH_OFFSET = -2800;

export interface Plaques {
  readonly group: Group;
  /** Draw calls per plaque in view, plus one for the merged cards. */
  readonly drawCallsPerPlaque: number;
  /** Text meshes typeset. */
  readonly lines: number;
  /** The typeset strings, for the diag and the e2e. */
  readonly texts: readonly string[];
  dispose(): void;
}

function srgb(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
}

function hex(rgb: Rgb): number {
  return srgb(rgb).getHex(SRGBColorSpace);
}

/** A box at `matrix` with one linear vertex colour for the merged, vertex-coloured cards. */
function colouredBox(
  width: number,
  height: number,
  depth: number,
  matrix: Matrix4,
  rgb: Rgb,
): BufferGeometry {
  const box = new BoxGeometry(width, height, depth);
  box.applyMatrix4(matrix);
  const linear = srgb(rgb);
  const colors = new Float32Array(box.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([linear.r, linear.g, linear.b], i);
  box.setAttribute('color', new BufferAttribute(colors, 3));
  return box;
}

/** The typeset height of a top-anchored text block, metres. */
function blockHeight(mesh: Text): number {
  const bounds = mesh.textRenderInfo?.blockBounds;
  return bounds ? bounds[3] - bounds[1] : 0;
}

/** The plaque's world transform: centred on its card, +Z facing into the room, `depth` off the wall. */
function plaqueMatrix(h: Hanging, depth: number): Matrix4 {
  const s = (h.plaque.s0 + h.plaque.s1) / 2;
  const centre = wallPoint(h.wall, s, PLAQUE_CENTRE_Y, depth);
  const yaw = Math.atan2(h.wall.normal[0], h.wall.normal[2]);
  return new Matrix4().compose(
    new Vector3(...centre),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
    new Vector3(1, 1, 1),
  );
}

function textMesh(
  text: string,
  size: number,
  anchorY: 'top' | 'bottom',
  material: MeshBasicMaterial,
): Text {
  const mesh = new Text();
  mesh.font = TEXT_FONT_URL;
  mesh.text = text;
  mesh.fontSize = size;
  mesh.lineHeight = 1.25;
  mesh.maxWidth = PLAQUE_WIDTH - 2 * PAD;
  mesh.anchorX = 'left';
  mesh.anchorY = anchorY;
  mesh.material = material;
  mesh.depthOffset = TEXT_DEPTH_OFFSET;
  return mesh;
}

/**
 * Builds and typesets the seven plaques; resolves once every text mesh has synced. Each plaque
 * typesets on its own frame after `nextFrame` resolves (P5.5, review M5): one troika typeset of all
 * seven took 89-164 ms in one go. Omitted, they typeset together.
 */
export async function createPlaques(
  hangings: readonly Hanging[],
  nextFrame?: () => Promise<void>,
): Promise<Plaques> {
  const group = new Group();
  group.name = 'plaques';
  const textMaterial = new MeshBasicMaterial();
  const cards: BufferGeometry[] = [];
  const meshes: Text[] = [];
  const blocks: [Text, Text][] = [];
  const gold = underpaint('moulding');
  for (const h of hangings) {
    cards.push(
      colouredBox(
        PLAQUE_WIDTH,
        PLAQUE_HEIGHT,
        PLAQUE_DEPTH,
        plaqueMatrix(h, PLAQUE_DEPTH / 2),
        PLAQUE_COLORS.card,
      ),
      colouredBox(
        PLAQUE_WIDTH + 2 * EDGE,
        PLAQUE_HEIGHT + 2 * EDGE,
        PLAQUE_DEPTH - EDGE_RECESS,
        plaqueMatrix(h, (PLAQUE_DEPTH - EDGE_RECESS) / 2),
        gold,
      ),
    );

    const plaque = new Group();
    plaque.name = `plaque-${h.painting.id}`;
    plaque.matrixAutoUpdate = false;
    plaque.matrix.copy(plaqueMatrix(h, PLAQUE_DEPTH + TEXT_LIFT));
    const { title, year, museum, status } = h.painting;
    const left = -PLAQUE_WIDTH / 2 + PAD;

    const heading = textMesh(title, TITLE_SIZE, 'top', textMaterial);
    heading.color = hex(PLAQUE_COLORS.title);
    heading.position.set(left, 0, 0);

    const lines = `${year}\n${museum}`;
    const soon = status === 'coming-soon';
    const detail = textMesh(
      soon ? `${lines}\nComing soon` : lines,
      DETAIL_SIZE,
      'top',
      textMaterial,
    );
    detail.color = hex(PLAQUE_COLORS.detail);
    if (soon) {
      detail.colorRanges = {
        0: hex(PLAQUE_COLORS.detail),
        [lines.length + 1]: hex(PLAQUE_COLORS.accent),
      };
    }
    detail.position.set(left, 0, 0);

    plaque.add(heading, detail);
    group.add(plaque);
    meshes.push(heading, detail);
    blocks.push([heading, detail]);
  }
  const cardMaterial = new MeshBasicMaterial({
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: CARD_DEPTH_UNITS,
  });
  const merged = mergeGeometries(cards);
  for (const card of cards) card.dispose();
  if (!merged) throw new Error('plaque cards failed to merge');
  const cardMesh = new Mesh(merged, cardMaterial);
  cardMesh.name = 'plaque-cards';
  group.add(cardMesh);
  const sync = (mesh: Text): Promise<void> => new Promise<void>((resolve) => mesh.sync(resolve));
  if (nextFrame) {
    for (const [heading, detail] of blocks) {
      await nextFrame();
      await Promise.all([sync(heading), sync(detail)]);
    }
  } else {
    await Promise.all(meshes.map(sync));
  }
  // The title, the gap and the details as one block, centred on the card. Moving a synced mesh
  // needs no new typeset.
  for (const [heading, detail] of blocks) {
    const titleHeight = blockHeight(heading);
    const total = titleHeight + BLOCK_GAP + blockHeight(detail);
    heading.position.y = total / 2;
    detail.position.y = total / 2 - titleHeight - BLOCK_GAP;
  }
  return {
    group,
    drawCallsPerPlaque: 2,
    lines: meshes.length,
    texts: meshes.map((mesh) => mesh.text),
    dispose() {
      group.removeFromParent();
      merged.dispose();
      cardMaterial.dispose();
      textMaterial.dispose();
      for (const mesh of meshes) mesh.dispose();
    },
  };
}
