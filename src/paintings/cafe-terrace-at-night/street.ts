import { Box3, Ray, Vector3 } from 'three';
import type { VolumeQuery } from '../../locomotion/teleport';
import type { WalkBounds } from '../../locomotion/walk-bounds';
import type { Vec3 } from '../../render/strokes/frame';

export const WALK_BOUNDS: WalkBounds = {
  minX: -3.1,
  maxX: 5.6,
  minZ: -17,
  maxZ: 5.8,
  // The walkable slice stays below the awning even with the shared flight controls.
  maxY: 2.8,
};

export function outsideStreet(x: number, z: number): boolean {
  const { minX, maxX, minZ, maxZ } = WALK_BOUNDS;
  return x < minX || x > maxX || z < minZ || z > maxZ;
}

/** The same volumes constrain walking and stop teleport arcs. */
export function streetVolumes(boxes: readonly Box3[]): VolumeQuery {
  const margin = new Vector3(0.16, 0, 0.16);
  const grown = boxes.map((box) => box.clone().expandByVector(margin));
  const mode = new Uint8Array(boxes.length);
  const point = new Vector3();
  const hit = new Vector3();
  const ray = new Ray();

  return {
    at(x, y, z) {
      point.set(x, y, z);
      return grown.findIndex((box) => box.containsPoint(point));
    },
    begin(x, y, z) {
      point.set(x, y, z);
      for (let i = 0; i < boxes.length; i++) {
        mode[i] = boxes[i].containsPoint(point) ? 1 : grown[i].containsPoint(point) ? 2 : 0;
      }
    },
    update(x, y, z) {
      point.set(x, y, z);
      for (let i = 0; i < boxes.length; i++) {
        if (mode[i] === 1 && !boxes[i].containsPoint(point)) mode[i] = 2;
      }
    },
    crossing(ax, ay, az, bx, by, bz) {
      ray.origin.set(ax, ay, az);
      ray.direction.set(bx - ax, by - ay, bz - az);
      const length = ray.direction.length();
      if (length > 0) ray.direction.multiplyScalar(1 / length);
      for (let i = 0; i < boxes.length; i++) {
        if (mode[i] === 1) continue;
        const box = mode[i] === 2 ? boxes[i] : grown[i];
        if (box.containsPoint(ray.origin)) return i;
        if (length > 0 && ray.intersectBox(box, hit) && hit.distanceTo(ray.origin) <= length) {
          return i;
        }
      }
      return -1;
    },
  };
}

export function solidBox(center: Vec3, size: Vec3): Box3 {
  return new Box3().setFromCenterAndSize(new Vector3(...center), new Vector3(...size));
}
