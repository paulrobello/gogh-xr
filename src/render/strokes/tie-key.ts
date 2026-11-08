/**
 * The stroke depth key (stroke.vert.glsl `iTie`): the hash the vertex shader used to compute per
 * vertex, built once per instance on the CPU. Every stroke geometry carries it: the batch chunks
 * (batch.ts) and the lone meshes: the teleport arc and the settings panel, which rewrite it with
 * their instances, and the portal fly strokes, which write it once (their depth test is off).
 */
import { DynamicDrawUsage, InstancedBufferAttribute } from 'three';
import { DEPTH_BACKDROP_FLAG } from './backdrop-depth';
import { DEPTH_RANKED_FLAG, float32Bits, lowbias32 } from './depth-tie-break';
import type { StrokeBuffers } from './instance';

/**
 * Writes the depth key of `buffers`' first `count` strokes into `out`, as the exact float of the
 * hash's top 24 bits: the size hash of a ranked stroke off the backdrop, else the position hash,
 * which the backdrop rank reads. The hashes are integer maths on the stored float32 bits, so every
 * key equals the one the shader hashed before (tests/strokes-tie-key.test.ts). 4 bytes per instance.
 */
export function writeTieKeys(
  buffers: StrokeBuffers,
  out: Float32Array,
  count = buffers.count,
): void {
  const p = buffers.position;
  const s = buffers.size;
  for (let i = 0; i < count; i++) {
    const flags = buffers.meta[i * 4 + 3];
    let key: number;
    if ((flags & DEPTH_RANKED_FLAG) !== 0 && (flags & DEPTH_BACKDROP_FLAG) === 0) {
      key = lowbias32(float32Bits(s[i * 2]) ^ lowbias32(float32Bits(s[i * 2 + 1])));
    } else {
      key = lowbias32(
        float32Bits(p[i * 3]) ^
          lowbias32(float32Bits(p[i * 3 + 1]) ^ lowbias32(float32Bits(p[i * 3 + 2]))),
      );
    }
    out[i] = key >>> 8;
  }
}

/** Every stroke's depth key in `buffers` (`writeTieKeys`). */
export function tieKeys(buffers: StrokeBuffers): Float32Array {
  const out = new Float32Array(buffers.count);
  writeTieKeys(buffers, out);
  return out;
}

/**
 * A lone stroke mesh's `iTie`, dynamic: a mesh that rewrites its instances rewrites the keys into
 * its array with `writeTieKeys` and flags it for upload.
 */
export function createTieKeyAttribute(buffers: StrokeBuffers): InstancedBufferAttribute {
  const attribute = new InstancedBufferAttribute(tieKeys(buffers), 1);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
}
