import { expect, test } from 'vitest';
import { strokeAxes, surfaceBasis, type Vec3 } from '../src/render/strokes/frame.ts';
import { mulberry32 } from '../src/util/prng.ts';

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function expectVec(actual: Vec3, expected: Vec3, digits = 6): void {
  for (let k = 0; k < 3; k++) expect(actual[k]).toBeCloseTo(expected[k], digits);
}

function expectRightHandedFrame(n: Vec3): void {
  const { b1, b2 } = surfaceBasis(n);
  expect(dot(b1, b1)).toBeCloseTo(1, 6);
  expect(dot(b2, b2)).toBeCloseTo(1, 6);
  expect(dot(b1, b2)).toBeCloseTo(0, 6);
  expect(dot(b1, n)).toBeCloseTo(0, 6);
  expect(dot(b2, n)).toBeCloseTo(0, 6);
  expectVec(cross(b1, b2), n, 6);
}

test('n = +z gives b1 = +x and b2 = +y', () => {
  const { b1, b2 } = surfaceBasis([0, 0, 1]);
  expectVec(b1, [1, 0, 0]);
  expectVec(b2, [0, 1, 0]);
});

test('axis normals, including n.z = 0 and n = -z, give finite right-handed frames', () => {
  const normals: Vec3[] = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, -1],
  ];
  for (const n of normals) {
    const { b1, b2 } = surfaceBasis(n);
    expect([...b1, ...b2].every(Number.isFinite)).toBe(true);
    expectRightHandedFrame(n);
  }
});

test('random normals give orthonormal right-handed frames', () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    expectRightHandedFrame([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
});

test('stroke axes rotate the long axis by the tangent and keep long × short = n', () => {
  const n: Vec3 = [0, 0, 1];
  expectVec(strokeAxes(n, 0).long, [1, 0, 0]);
  expectVec(strokeAxes(n, 0).short, [0, 1, 0]);
  expectVec(strokeAxes(n, Math.PI / 2).long, [0, 1, 0]);
  expectVec(strokeAxes(n, Math.PI / 2).short, [-1, 0, 0]);
  const rand = mulberry32(3);
  for (let i = 0; i < 200; i++) {
    const tilted: Vec3 = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const len = Math.hypot(...tilted);
    const unit: Vec3 = [tilted[0] / len, tilted[1] / len, tilted[2] / len];
    const { long, short } = strokeAxes(unit, rand() * Math.PI * 2);
    expect(dot(long, unit)).toBeCloseTo(0, 6);
    expect(dot(long, short)).toBeCloseTo(0, 6);
    expectVec(cross(long, short), unit, 6);
  }
});
