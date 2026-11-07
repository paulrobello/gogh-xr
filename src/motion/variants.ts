/**
 * Motion A/B variants (src/diag/ab.ts, `?wrap` and `?flame`): alternatives to the sky swirl's wrap
 * shrink (P4.2) and the cypress sway (P4.4), switched live by two shared uniforms. motion.glsl reads
 * `uSkyWrap` only inside skyMotion and `uCypressSway` only inside cypressMotion, and a stroke is on
 * one layer, so each moving vertex pays one compare, and a still one none. At 0, base, each motion
 * runs today's code unchanged.
 *
 * - wrap `fade`: the stroke stays at full size through the wrap, and its colour cross-fades toward
 *   the local sky base colour over the same wrap window, so the jump happens while it matches its
 *   backdrop. The base colour is the mean colour of the sky strokes by direction from the painter's
 *   eye (`skyBaseMap`), an octahedral map sampled in the vertex shader inside the fade only.
 * - wrap `half`: the stroke shrinks to SKY_WRAP_HALF_FLOOR of its size instead of nothing, over a
 *   SKY_WRAP_HALF_PERIOD loop. It sweeps the same arc as base over the longer loop, so it moves at
 *   2/3 of base's speed and every reach bound (cull, haze thin) still holds.
 * - flame `wind`: the sway runs along the world-fixed CYPRESS_WIND, across the painter's view of
 *   the cypress, at CYPRESS_WIND_MAX × h² instead of along each face's tangent.
 *
 * The uniforms live in variant-uniforms.ts, apart from these tables, so the scatter's import of
 * the cypress flame does not pull in three.
 */

/** The sky swirl's wrap treatments (`?wrap`, the `wrap` A/B group), base first. */
export const SKY_WRAPS = ['base', 'fade', 'half'] as const;
export type SkyWrap = (typeof SKY_WRAPS)[number];
/** The cypress sways (`?flame`, the `flame` A/B group), base first. */
export const FLAME_SWAYS = ['base', 'wind'] as const;
export type FlameSway = (typeof FLAME_SWAYS)[number];

/** The `half` wrap's loop, seconds: 3600 / 300, 1.5 × the base 8 s, dividing the 3600 s wrap. */
export const SKY_WRAP_HALF_PERIOD: number = 12;
/** The `half` wrap's smallest size, as a share of the rest size. */
export const SKY_WRAP_HALF_FLOOR: number = 0.5;
/**
 * The `wind` sway's amplitude at normalised height 1, metres: 0.15 m × h², against base's 0.14 m
 * along the face tangent. 0.3 m left up to 1.23% of the view bare at the cypress poses and 0.2 m
 * 0.58%, over the 0.5% limit (docs/verification.md, sky wrap and cypress sway variants).
 */
export const CYPRESS_WIND_MAX: number = 0.15;
/**
 * The `wind` sway's world direction: horizontal and perpendicular to the painter's eye's view of the
 * main cypress mass at mid height (tests/motion-variants.test.ts checks it), so the outline sways
 * across the view rather than in depth.
 */
export const CYPRESS_WIND: readonly [number, number, number] = Object.freeze([
  0.92754, 0, -0.37372,
]) as readonly [number, number, number];
/** Texels per side of the octahedral sky base map. */
export const SKY_BASE_SIZE: number = 64;

/** The shader codes of each variant: its index in SKY_WRAPS and FLAME_SWAYS. */
export const skyWrapCode = (wrap: SkyWrap): number => SKY_WRAPS.indexOf(wrap);
export const flameSwayCode = (sway: FlameSway): number => FLAME_SWAYS.indexOf(sway);

/**
 * Matches skyBaseUv in motion.glsl: the octahedral uv of direction (x, y, z), +Y at the centre, so
 * the upper hemisphere is the unfolded diamond and the lower one folds into the corners.
 */
export function skyBaseUv(x: number, y: number, z: number): [number, number] {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let ex = x / s;
  let ez = z / s;
  if (y < 0) {
    const ox = ex;
    ex = (1 - Math.abs(ez)) * (ox >= 0 ? 1 : -1);
    ez = (1 - Math.abs(ox)) * (ez >= 0 ? 1 : -1);
  }
  return [ex * 0.5 + 0.5, ez * 0.5 + 0.5];
}

/** The stroke data `skyBaseMap` reads: instance arrays as the batch's chunk geometries hold them. */
export interface SkyBaseStrokes {
  readonly count: number;
  /** xyz per stroke. */
  readonly position: ArrayLike<number>;
  /** rgba bytes per stroke. */
  readonly color: ArrayLike<number>;
  /** Four bytes per stroke: the layer is the second. */
  readonly meta: ArrayLike<number>;
}

/**
 * The `fade` wrap's target: per octahedral texel of direction from `eye`, the mean colour of the
 * `layer` strokes in it, spread by two 3 × 3 box passes that carry their weights, so a texel with
 * few strokes takes its neighbours' mean. A texel no stroke reaches takes the mean of them all.
 * RGBA bytes, `size` × `size`, in iColor's own encoding, so the shader mixes like with like.
 */
export function skyBaseMap(
  sets: readonly SkyBaseStrokes[],
  layer: number,
  eye: readonly [number, number, number],
  size: number = SKY_BASE_SIZE,
): Uint8Array {
  const n = size * size;
  let sum = new Float64Array(n * 4);
  const total = [0, 0, 0, 0];
  for (const set of sets) {
    for (let i = 0; i < set.count; i++) {
      if (set.meta[i * 4 + 1] !== layer) continue;
      const [u, v] = skyBaseUv(
        set.position[i * 3] - eye[0],
        set.position[i * 3 + 1] - eye[1],
        set.position[i * 3 + 2] - eye[2],
      );
      const tx = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
      const ty = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
      const t = (ty * size + tx) * 4;
      for (let c = 0; c < 3; c++) {
        sum[t + c] += set.color[i * 4 + c];
        total[c] += set.color[i * 4 + c];
      }
      sum[t + 3] += 1;
      total[3] += 1;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(n * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = (y * size + x) * 4;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= size) continue;
            const s = (yy * size + xx) * 4;
            for (let c = 0; c < 4; c++) next[t + c] += sum[s + c];
          }
        }
      }
    }
    sum = next;
  }
  const out = new Uint8Array(n * 4);
  for (let t = 0; t < n * 4; t += 4) {
    const w = sum[t + 3];
    for (let c = 0; c < 3; c++) {
      const mean = w > 0 ? sum[t + c] / w : total[3] > 0 ? total[c] / total[3] : 0;
      out[t + c] = Math.min(255, Math.max(0, Math.round(mean)));
    }
    out[t + 3] = 255;
  }
  return out;
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/** The material defines the variant branches in motion.glsl read. */
export function motionVariantGlslDefines(): Record<string, string | number> {
  return {
    SKY_WRAP_FADE: `${skyWrapCode('fade')}u`,
    SKY_WRAP_HALF: `${skyWrapCode('half')}u`,
    SKY_WRAP_HALF_INV_PERIOD: glslFloat(1 / SKY_WRAP_HALF_PERIOD),
    SKY_WRAP_HALF_DEPTH: glslFloat(1 - SKY_WRAP_HALF_FLOOR),
    CYPRESS_SWAY_WIND: `${flameSwayCode('wind')}u`,
    CYPRESS_WIND_MAX: glslFloat(CYPRESS_WIND_MAX),
    CYPRESS_WIND: `vec3(${CYPRESS_WIND.map(glslFloat).join(', ')})`,
  };
}
