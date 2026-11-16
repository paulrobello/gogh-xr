import { CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../../render/strokes/frame';
import { awningOver, ID, LAMP, RAFTER_DROP, SWATCH } from './layout';
import type { Paint, PaintBuilder } from './paint';

const IRON = 0x313c37;
const LANTERN = 0xf5cd60;
/** As big as the scan paints it: about 0.7 m of glass. */
const BIG = 1.6;

/** The lantern: six lit panes in an iron cage, hung by a rod from the awning's rafter over it. */
export function buildLantern(lamp: PaintBuilder): void {
  const transform = new Matrix4();
  const upright = new Quaternion();
  const placed = (at: Vec3, size: Vec3): Matrix4 =>
    transform.compose(new Vector3(...at), upright, new Vector3(...size));
  const cylinder = new CylinderGeometry(1, 1, 1, 14);
  const glass = new CylinderGeometry(0.2, 0.15, 0.42, 6);
  const cap = new CylinderGeometry(0.04, 0.25, 0.16, 6);
  const cage: Paint = { id: ID.lamp, swatch: SWATCH.plaster, tint: IRON, round: true };
  const lit: Paint = { ...cage, tint: LANTERN, painted: false, lit: true };
  const [x, y, z] = LAMP;
  lamp.mesh(glass, placed(LAMP, [BIG, BIG, BIG]), lit);
  lamp.mesh(cap, placed([x, y + 0.29 * BIG, z], [BIG, BIG, BIG]), cage);
  lamp.mesh(cap, placed([x, y - 0.25 * BIG, z], [0.7 * BIG, -0.5 * BIG, 0.7 * BIG]), cage);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    lamp.mesh(
      cylinder,
      placed(
        [x + 0.185 * BIG * Math.cos(a), y, z + 0.185 * BIG * Math.sin(a)],
        [0.016, 0.44 * BIG, 0.016],
      ),
      cage,
    );
  }
  // The rod: from inside the cap up into the rafter over it.
  const foot = y + 0.33 * BIG;
  const head = awningOver(x, z).y - RAFTER_DROP;
  lamp.mesh(cylinder, placed([x, (foot + head) / 2, z], [0.014, head - foot, 0.014]), cage);
  for (const geometry of [cylinder, glass, cap]) geometry.dispose();
}
