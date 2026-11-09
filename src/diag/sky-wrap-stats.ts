/**
 * The `wrap` diag key (main.ts, CLAUDE.md, Motion A/B variants): the drawn sky strokes of the bound
 * batch under the active wrap variant at a motion time, from the TS mirror (skyWrapPhase and
 * skyWrapLoop) at each stroke's phase byte, or at the `?motionphase` pin as the shader uses it.
 */

import {
  hashSkyDirections,
  SKY_COUNTER_FLOW_RADIUS,
  type SkyCounterFlow,
  type SkyDirectionHash,
  skyCounterFlow,
} from '../motion/sky-counter-flow';
import {
  SKY_WAVE_JITTER,
  skyVelocity,
  skyWavePhase,
  skyWavePolesFor,
  skyWrapLoop,
} from '../motion/sky-swirl';
import type { SkyWaveTurns, SkyWrap } from '../motion/variants';
import { PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import type { StrokeBatch } from '../render/strokes/batch';
import { strokeAxes } from '../render/strokes/frame';
import { octDecode, STROKE_LAYER } from '../render/strokes/instance';

/** At most this many drawn sky strokes are the counter-flow's centres, evenly spaced. */
export const SKY_WRAP_STATS_CENTRES: number = 4000;

export interface SkyWrapStats {
  readonly wrap: SkyWrap;
  /** The wave wrap's waves per turn (`uWaveTurns`), whichever wrap is active. */
  readonly waveTurns: SkyWaveTurns;
  /** Sky strokes drawn by the chunks that passed the last cull. */
  readonly drawn: number;
  /** Of those, the ones below 0.8 of their rest size (base's wrap shrink). */
  readonly small: number;
  /** Of those, the ones on their way back along the arc (pingpong and wave). */
  readonly returning: number;
  /** Of those, the ones lift draws shorter than full length: inside a lift window. */
  readonly cut: number;
  /** cut / drawn: the share of the drawn sky strokes in transition. */
  readonly cutShare: number;
  /**
   * How the drawn sky strokes' long axes at rest lie against the swirl's flow, |cos| of the angle
   * between the long axis and omega × d: the share within 30° of it (|cos| ≥ cos 30°), the share
   * more than 60° off it (|cos| < ½), which lift shortens mostly across their travel,
   * and the median |cos|. Strokes where the flow is still count as crossways.
   */
  readonly alignment: {
    readonly within30: number;
    readonly beyond60: number;
    readonly median: number;
  };
  /** (drawn − returning) / drawn: the share moving forward along the flow. */
  readonly forwardShare: number;
  /** returning / drawn. */
  readonly returningShare: number;
  /**
   * The local counter-flow (src/motion/sky-counter-flow.ts) among the drawn sky strokes: up to
   * SKY_WRAP_STATS_CENTRES of them as centres, every drawn sky stroke within `radiusDeg` of one as
   * its neighbours.
   */
  readonly counterFlow: SkyCounterFlow & { readonly radiusDeg: number; readonly centres: number };
}

/** The batch's sky strokes, gathered once: where each sits in its chunk, and its loop phases. */
interface SkyStrokes {
  /** Per chunk, its sky instances' indices in the chunk; stroke k of chunk c is `start[c] + k`. */
  readonly local: readonly Uint32Array[];
  readonly start: readonly number[];
  /** The phase fraction the shader uses: the `?motionphase` pin, else the phase byte / 256. */
  readonly phase: Float32Array;
  /** The wave's loop phase (skyWrapPhase under `wave`) at the gathered waves per turn. */
  readonly wave: Float32Array;
  /** |cos| of the angle between each stroke's long axis at rest and the flow omega × d. */
  readonly along: Float32Array;
  readonly hash: SkyDirectionHash;
}

const cache = new WeakMap<
  StrokeBatch,
  { pin: number | null; turns: SkyWaveTurns; strokes: SkyStrokes }
>();

function gather(batch: StrokeBatch, pin: number | null, turns: SkyWaveTurns): SkyStrokes {
  const poles = skyWavePolesFor(turns);
  const local: Uint32Array[] = [];
  const start: number[] = [];
  let total = 0;
  for (const chunk of batch.chunks) {
    const meta = chunk.geometry.getAttribute('iMeta').array;
    const indices: number[] = [];
    for (let i = 0; i < chunk.count; i++) {
      if (meta[i * 4 + 1] === STROKE_LAYER.sky) indices.push(i);
    }
    local.push(Uint32Array.from(indices));
    start.push(total);
    total += indices.length;
  }
  const phase = new Float32Array(total);
  const wave = new Float32Array(total);
  const along = new Float32Array(total);
  const directions = new Float32Array(3 * total);
  batch.chunks.forEach((chunk, c) => {
    const meta = chunk.geometry.getAttribute('iMeta').array;
    const position = chunk.geometry.getAttribute('iPosition').array;
    const normal = chunk.geometry.getAttribute('iNormal').array;
    const tangent = chunk.geometry.getAttribute('iTangent').array;
    // snorm16 and unorm16 as the GPU reads them; a float array is already the value.
    const snorm = (x: number): number =>
      normal instanceof Int16Array ? Math.max(x / 32767, -1) : x;
    const unorm = (x: number): number => (tangent instanceof Uint16Array ? x / 65535 : x);
    local[c].forEach((i, k) => {
      const s = start[c] + k;
      const dx = position[3 * i] - PAINTER_EYE[0];
      const dy = position[3 * i + 1] - PAINTER_EYE[1];
      const dz = position[3 * i + 2] - PAINTER_EYE[2];
      const inv = 1 / Math.hypot(dx, dy, dz);
      directions[3 * s] = dx * inv;
      directions[3 * s + 1] = dy * inv;
      directions[3 * s + 2] = dz * inv;
      phase[s] = pin ?? meta[i * 4 + 2] / 256;
      wave[s] =
        skyWavePhase([dx * inv, dy * inv, dz * inv], poles) + SKY_WAVE_JITTER * (phase[s] - 0.5);
      const n = octDecode(snorm(normal[2 * i]), snorm(normal[2 * i + 1]));
      const { long } = strokeAxes(n, unorm(tangent[i]) * 2 * Math.PI);
      const v = skyVelocity([dx * inv, dy * inv, dz * inv]);
      const speed = Math.hypot(v[0], v[1], v[2]);
      along[s] = speed > 0 ? Math.abs(long[0] * v[0] + long[1] * v[1] + long[2] * v[2]) / speed : 0;
    });
  });
  return { local, start, phase, wave, along, hash: hashSkyDirections(directions) };
}

/**
 * The `wrap` diag of `batch` under `wrap` at motion time `time`, with `pin` the `?motionphase` pin
 * or null, and the wave at `turns` waves per turn. The sky strokes' directions, hash and wave
 * phases are gathered once per batch, pin and turns.
 */
export function skyWrapStats(
  batch: StrokeBatch,
  wrap: SkyWrap,
  time: number,
  pin: number | null,
  turns: SkyWaveTurns,
): SkyWrapStats {
  let entry = cache.get(batch);
  if (!entry || entry.pin !== pin || entry.turns !== turns) {
    entry = { pin, turns, strokes: gather(batch, pin, turns) };
    cache.set(batch, entry);
  }
  const strokes = entry.strokes;
  const loopPhase = wrap === 'wave' ? strokes.wave : strokes.phase;
  // 255 marks a stroke not drawn this frame, which skyCounterFlow leaves out.
  const returning = new Uint8Array(strokes.phase.length).fill(255);
  const drawnIndices: number[] = [];
  let small = 0;
  let back = 0;
  let cut = 0;
  const along: number[] = [];
  batch.chunks.forEach((chunk, c) => {
    if (!chunk.mesh.visible) return;
    const local = strokes.local[c];
    const end = chunk.drawStart + chunk.drawCount;
    for (let k = 0; k < local.length && local[k] < end; k++) {
      if (local[k] < chunk.drawStart) continue;
      const s = strokes.start[c] + k;
      const loop = skyWrapLoop(wrap, loopPhase[s], time);
      returning[s] = loop.returning ? 1 : 0;
      drawnIndices.push(s);
      if (1 + loop.gain < 0.8) small++;
      if (loop.returning) back++;
      if (loop.clip !== 0) cut++;
      along.push(strokes.along[s]);
    }
  });
  const drawn = drawnIndices.length;
  const step = Math.max(1, drawn / SKY_WRAP_STATS_CENTRES);
  const centres: number[] = [];
  for (let x = 0; x < drawn; x += step) centres.push(drawnIndices[Math.floor(x)]);
  return {
    wrap,
    waveTurns: turns,
    drawn,
    small,
    cut,
    cutShare: drawn > 0 ? cut / drawn : 0,
    alignment: {
      within30: drawn > 0 ? along.filter((a) => a >= Math.cos(Math.PI / 6)).length / drawn : 0,
      beyond60: drawn > 0 ? along.filter((a) => a < 0.5).length / drawn : 0,
      median: drawn > 0 ? along.sort((a, b) => a - b)[Math.floor(drawn / 2)] : 0,
    },
    returning: back,
    forwardShare: drawn > 0 ? (drawn - back) / drawn : 0,
    returningShare: drawn > 0 ? back / drawn : 0,
    counterFlow: {
      ...skyCounterFlow(strokes.hash, returning, centres),
      radiusDeg: (SKY_COUNTER_FLOW_RADIUS * 180) / Math.PI,
      centres: centres.length,
    },
  };
}
