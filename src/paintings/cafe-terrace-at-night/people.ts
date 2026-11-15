import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  type MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../../render/strokes/frame';

export interface Person {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly yaw: number;
  readonly coat: number;
  readonly hat: number;
  readonly skin: number;
  readonly accent: number;
  readonly pose: 'standing' | 'seated' | 'server' | 'dress';
}

export function createPeople(material: MeshBasicMaterial) {
  const coat = new CylinderGeometry(0.84, 1, 1, 9);
  const limb = new CylinderGeometry(0.88, 1, 1, 7);
  const face = new IcosahedronGeometry(1, 1);
  const box = new BoxGeometry();
  const transform = new Matrix4();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);
  const color = new Color();
  return {
    person(spec: Person): Group {
      const person = new Group();
      person.position.set(spec.x, 0, spec.z);
      person.rotation.y = spec.yaw;
      const parts: BufferGeometry[] = [];
      const h = spec.height;
      const seat = spec.pose === 'seated';
      const dress = spec.pose === 'dress';
      const server = spec.pose === 'server';
      const hip = seat ? 0.45 : h * 0.47;
      const shoulders = hip + h * 0.28;
      const headY = shoulders + h * 0.112;

      function piece(
        shape: BufferGeometry,
        at: Vec3,
        size: Vec3,
        ink: number,
        rotation: Quaternion = new Quaternion(),
      ): void {
        const geometry = (shape.index ? shape.toNonIndexed() : shape.clone()).applyMatrix4(
          transform.compose(new Vector3(...at), rotation, scale.set(...size)),
        );
        color.setHex(ink);
        const colors = new Float32Array(geometry.getAttribute('position').count * 3);
        for (let i = 0; i < colors.length; i += 3) {
          colors[i] = color.r;
          colors[i + 1] = color.g;
          colors[i + 2] = color.b;
        }
        geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
        parts.push(geometry);
      }

      function segment(a: Vec3, b: Vec3, radius: number, ink: number): void {
        const direction = new Vector3(...b).sub(new Vector3(...a));
        const length = direction.length();
        quaternion.setFromUnitVectors(up, direction.normalize());
        piece(
          limb,
          [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
          [radius, length, radius * 0.87],
          ink,
          quaternion,
        );
      }

      const trousers = 0x343d3e;
      for (const side of [-1, 1]) {
        const knee: Vec3 = [side * h * 0.052, seat ? 0.4 : hip * 0.48, seat ? 0.2 : side * 0.037];
        const foot: Vec3 = [side * h * 0.056, 0.065, seat ? 0.23 : side * 0.06];
        const elbow: Vec3 = [side * h * (seat ? 0.132 : 0.147), shoulders - h * 0.15, 0.022];
        const hand: Vec3 = [
          side * h * (seat ? 0.068 : 0.134),
          seat ? hip + 0.1 : shoulders - h * (server && side > 0 ? 0.15 : 0.245),
          seat ? 0.16 : server && side > 0 ? 0.24 : 0.037,
        ];
        if (!dress) {
          segment([side * h * 0.05, hip, 0], knee, h * 0.041, trousers);
          segment(knee, foot, h * 0.035, trousers);
        }
        piece(face, [foot[0], 0.043, foot[2] + 0.035], [h * 0.047, 0.047, h * 0.08], 0x252a2c);
        segment([side * h * 0.094, shoulders - 0.015, 0], elbow, h * 0.036, spec.coat);
        segment(elbow, hand, h * 0.029, spec.coat);
        piece(face, hand, [0.038, 0.05, 0.035], spec.skin);
      }

      const hem = dress ? 0.14 : hip - 0.067;
      piece(
        coat,
        [0, (hem + shoulders) / 2, 0],
        [h * (dress ? 0.149 : 0.113), shoulders - hem, h * 0.069],
        spec.coat,
      );
      piece(face, [0, shoulders - 0.015, 0], [h * 0.111, h * 0.065, h * 0.059], spec.coat);
      piece(limb, [0, shoulders + 0.066, 0], [h * 0.041, h * 0.08, h * 0.04], spec.accent);
      const apronHem = server ? 0.23 : hem + (shoulders - hem) * 0.16;
      const apronTop = server ? shoulders - 0.06 : shoulders - (shoulders - hem) * 0.16;
      piece(
        box,
        [0, (apronTop + apronHem) / 2, h * 0.067],
        [h * (server ? 0.131 : 0.018), apronTop - apronHem, 0.023],
        spec.accent,
      );
      if (server) {
        piece(
          limb,
          [h * 0.132, shoulders - h * 0.15 + 0.042, 0.24],
          [0.155, 0.022, 0.135],
          0x9b9270,
        );
      }
      piece(face, [0, headY, 0], [h * 0.061, h * 0.078, h * 0.063], spec.skin);
      piece(face, [0, headY + h * 0.025, h * 0.061], [h * 0.014, h * 0.024, h * 0.022], spec.skin);
      piece(face, [0, headY + h * 0.025, -h * 0.027], [h * 0.06, h * 0.058, h * 0.044], 0x463930);
      if (server) {
        piece(face, [0, headY + h * 0.058, -0.018], [h * 0.063, h * 0.032, 0.092], 0x463930);
      } else {
        piece(limb, [0, headY + h * 0.067, 0], [h * 0.107, h * 0.017, h * 0.083], spec.hat);
        piece(coat, [0, headY + h * 0.093, 0], [h * 0.065, h * 0.057, h * 0.062], spec.hat);
        piece(limb, [0, headY + h * 0.083, 0], [h * 0.071, h * 0.012, h * 0.067], spec.accent);
      }
      for (const side of [-1, 1]) {
        piece(
          face,
          [side * h * 0.022, headY + h * 0.018, h * 0.056],
          [0.012, 0.008, 0.007],
          0x433b37,
        );
      }
      const geometry = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      person.add(new Mesh(geometry, material));
      return person;
    },
    dispose() {
      for (const geometry of [coat, limb, face, box]) geometry.dispose();
    },
  };
}
