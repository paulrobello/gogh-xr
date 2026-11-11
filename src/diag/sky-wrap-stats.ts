/**
 * The `wrap` diag key (main.ts, CLAUDE.md, Motion A/B variants): the drawn sky strokes of the bound
 * batch under the active wrap variant at a motion time, from the TS mirror (skyWrapPhase and
 * skyWrapLoop) at each stroke's phase byte, or at the `?motionphase` pin as the shader uses it.
 * Under the river arms, `wheelrun` and `wheelflow`, each stroke's velocity and forward-and-back
 * phase come from its chunk's iRiver, as the shader reads them, and the wheels are the kept three
 * (SKY_RIVER_WHEELS).
 */

import {
  hashSkyDirections,
  SKY_COUNTER_FLOW_RADIUS,
  type SkyCounterFlow,
  type SkyDirectionHash,
  skyCounterFlow,
} from '../motion/sky-counter-flow';
import {
  isSkyRiverWrap,
  SKY_RIVER_JITTER,
  SKY_RIVER_WHEELS,
  SKY_WAVE_JITTER,
  skyVelocity,
  skyWavePhase,
  skyWavePolesFor,
  skyWheelAt,
  skyWheelFlowTravel,
  skyWrapLoop,
} from '../motion/sky-swirl';
import type { SkyWaveTurns, SkyWrap } from '../motion/variants';
import { PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import type { StrokeBatch } from '../render/strokes/batch';
import { strokeAxes } from '../render/strokes/frame';
import { octDecode, STROKE_LAYER } from '../render/strokes/instance';
import { SKY_LIGHT_CULL_FLAG } from '../render/strokes/sky-light-cull';

/** At most this many drawn sky strokes are the counter-flow's centres, evenly spaced. */
export const SKY_WRAP_STATS_CENTRES: number = 4000;

export interface SkyWrapStats {
  readonly wrap: SkyWrap;
  /** The wave wrap's waves per turn (`uWaveTurns`), whichever wrap is active. */
  readonly waveTurns: SkyWaveTurns;
  /** Sky strokes drawn by the chunks that passed the last cull. */
  readonly drawn: number;
  /**
   * Of those, the ones below 0.8 of their rest size (base's wrap shrink). Under wheelrun it is
   * base's envelope outside the wheels before wheelrun scales it by the stroke's travel and calm
   * (skyWheelRunGain), so an upper bound.
   */
  readonly small: number;
  /**
   * Of those, the ones on their way back along the arc (pingpong and wave). Under wheelflow and
   * wheelrun only the strokes outside the wheels with a travel share above 0 (skyWheelFlowTravel)
   * count: a wheel member turns rigidly and a stroke holding still has no way back.
   */
  readonly returning: number;
  /**
   * Of those, the ones inside a wheel (skyWheelAt), which turn under wheel, the haze included.
   * Under wheelflow and wheelrun only the kept wheels (SKY_RIVER_WHEELS) count, since the big
   * swirl's strokes travel along the river there.
   */
  readonly wheeled: number;
  /** Of those, the ones whose paint streams: every one under stream, none under any other wrap. */
  readonly streaming: number;
  /**
   * How the drawn sky strokes' long axes at rest lie against the swirl's flow, |cos| of the angle
   * between the long axis and omega × d (the river's iRiver omega under wheelflow and wheelrun):
   * the share within 30° of it (|cos| ≥ cos 30°), the share more than 60° off it (|cos| < ½), and
   * the median |cos|. Under stream the paint streams along each stroke's length, so this says how
   * much of it streams along the flow. Strokes where the flow is still count as crossways.
   */
  readonly alignment: {
    readonly within30: number;
    readonly beyond60: number;
    readonly median: number;
  };
  /**
   * (drawn − returning) / drawn: the share moving forward along the flow. Under wheelflow and
   * wheelrun the wheel members are left out of this, of returningShare and of their denominator,
   * and so of the counter-flow: the shares are over the strokes outside the wheels.
   */
  readonly forwardShare: number;
  /** returning / drawn, with the same denominator as forwardShare. */
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
  /** The wave's loop phase (skyWrapPhase under `wave` and `wheelflow`) at the gathered turns. */
  readonly wave: Float32Array;
  /** |cos| of the angle between each stroke's long axis at rest and the flow omega × d. */
  readonly along: Float32Array;
  /** Each stroke's wheel index (skyWheelAt), -1 outside every wheel. */
  readonly wheel: Int8Array;
  /** Each stroke's kept wheel index (skyWheelAt over SKY_RIVER_WHEELS), -1 outside them. */
  readonly riverWheel: Int8Array;
  /** The river's velocity at each stroke, cross(iRiver.xyz, d̂), xyz each; 0 with no iRiver. */
  readonly riverVelocity: Float32Array;
  /** wheelflow's loop phase: iRiver.w plus the jitter of the phase fraction. */
  readonly riverPhase: Float32Array;
  /** wheelflow's winding fade, floor(iRiver.w) / 255. */
  readonly riverFade: Float32Array;
  /** |cos| of the angle between each stroke's long axis at rest and the river's velocity. */
  readonly riverAlong: Float32Array;
  /** Each stroke's direction from the painter's eye and the field's velocity there, xyz each. */
  readonly directions: Float32Array;
  readonly velocity: Float32Array;
  /**
   * The angular half extent wheelflow keeps clear on top of each stroke's centre at band size 1
   * (stroke.vert.glsl flowExtent): the haze's half diagonal over its distance, 0 for the dome.
   */
  readonly kept: Float32Array;
  /** Each stroke's batch chunk index. */
  readonly chunk: Uint16Array;
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
  const wheel = new Int8Array(total);
  const riverWheel = new Int8Array(total);
  const riverVelocity = new Float32Array(3 * total);
  const riverPhase = new Float32Array(total);
  const riverFade = new Float32Array(total);
  const riverAlong = new Float32Array(total);
  const directions = new Float32Array(3 * total);
  const velocity = new Float32Array(3 * total);
  const kept = new Float32Array(total);
  const chunkOf = new Uint16Array(total);
  batch.chunks.forEach((chunk, c) => {
    const meta = chunk.geometry.getAttribute('iMeta').array;
    const position = chunk.geometry.getAttribute('iPosition').array;
    const normal = chunk.geometry.getAttribute('iNormal').array;
    const tangent = chunk.geometry.getAttribute('iTangent').array;
    const size = chunk.geometry.getAttribute('iSize').array;
    const iRiver = chunk.geometry.getAttribute('iRiver')?.array;
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
      velocity[3 * s] = v[0];
      velocity[3 * s + 1] = v[1];
      velocity[3 * s + 2] = v[2];
      chunkOf[s] = c;
      if ((meta[i * 4 + 3] & SKY_LIGHT_CULL_FLAG) !== 0) {
        kept[s] = 0.5 * Math.hypot(size[2 * i], size[2 * i + 1]) * inv;
      }
      const speed = Math.hypot(v[0], v[1], v[2]);
      along[s] = speed > 0 ? Math.abs(long[0] * v[0] + long[1] * v[1] + long[2] * v[2]) / speed : 0;
      wheel[s] = skyWheelAt([dx * inv, dy * inv, dz * inv]);
      riverWheel[s] = skyWheelAt([dx * inv, dy * inv, dz * inv], SKY_RIVER_WHEELS);
      if (iRiver) {
        const wx = iRiver[4 * i];
        const wy = iRiver[4 * i + 1];
        const wz = iRiver[4 * i + 2];
        const rv: [number, number, number] = [
          wy * dz * inv - wz * dy * inv,
          wz * dx * inv - wx * dz * inv,
          wx * dy * inv - wy * dx * inv,
        ];
        riverVelocity[3 * s] = rv[0];
        riverVelocity[3 * s + 1] = rv[1];
        riverVelocity[3 * s + 2] = rv[2];
        riverPhase[s] = iRiver[4 * i + 3] + SKY_RIVER_JITTER * (phase[s] - 0.5);
        riverFade[s] = Math.floor(iRiver[4 * i + 3]) / 255;
        const rs = Math.hypot(rv[0], rv[1], rv[2]);
        riverAlong[s] =
          rs > 0 ? Math.abs(long[0] * rv[0] + long[1] * rv[1] + long[2] * rv[2]) / rs : 0;
      }
    });
  });
  return {
    local,
    start,
    phase,
    wave,
    along,
    wheel,
    riverWheel,
    riverVelocity,
    riverPhase,
    riverFade,
    riverAlong,
    directions,
    velocity,
    kept,
    chunk: chunkOf,
    hash: hashSkyDirections(directions),
  };
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
  const river = isSkyRiverWrap(wrap);
  const loopPhase =
    wrap === 'wave' ? strokes.wave : wrap === 'wheelflow' ? strokes.riverPhase : strokes.phase;
  const wheelOf = river ? strokes.riverWheel : strokes.wheel;
  const velocity = river ? strokes.riverVelocity : strokes.velocity;
  const alongOf = river ? strokes.riverAlong : strokes.along;
  const bandSize = (c: number): number => {
    const band = batch.chunks[c].band;
    return band ? batch.sizeMultiplier(band) : 1;
  };
  // Under wheelflow and wheelrun a stroke in a kept wheel turns rigidly and has no loop along the
  // arc.
  const wheels = river;
  // 255 marks a stroke not drawn this frame, which skyCounterFlow leaves out.
  const returning = new Uint8Array(strokes.phase.length).fill(255);
  const drawnIndices: number[] = [];
  let small = 0;
  let back = 0;
  let members = 0;
  let wheeled = 0;
  let streaming = 0;
  const along: number[] = [];
  batch.chunks.forEach((chunk, c) => {
    if (!chunk.mesh.visible) return;
    const local = strokes.local[c];
    const end = chunk.drawStart + chunk.drawCount;
    for (let k = 0; k < local.length && local[k] < end; k++) {
      if (local[k] < chunk.drawStart) continue;
      const s = strokes.start[c] + k;
      const member = wheels && wheelOf[s] >= 0;
      const loop = member ? skyWrapLoop('wheel', 0, time) : skyWrapLoop(wrap, loopPhase[s], time);
      // A stroke whose travel share is 0 holds still, so it has no way back along the arc. The
      // haze's kept extent is taken at its band's size, before fit caps and flight growth.
      const back1 =
        loop.returning &&
        (wrap !== 'wheelflow' || strokes.riverFade[s] > 0) &&
        (!wheels ||
          skyWheelFlowTravel(
            dirAt(strokes.directions, s),
            dirAt(velocity, s),
            strokes.kept[s] * bandSize(strokes.chunk[s]),
            SKY_RIVER_WHEELS,
          ) > 0);
      returning[s] = member ? 255 : back1 ? 1 : 0;
      drawnIndices.push(s);
      if (member) members++;
      if (1 + loop.gain < 0.8) small++;
      if (back1) back++;
      if (wheelOf[s] >= 0) wheeled++;
      if (wrap === 'stream') streaming++;
      along.push(alongOf[s]);
    }
  });
  const drawn = drawnIndices.length;
  // The forward and returning shares are over the strokes that move along an arc.
  const along1 = drawn - members;
  const step = Math.max(1, drawn / SKY_WRAP_STATS_CENTRES);
  const centres: number[] = [];
  for (let x = 0; x < drawn; x += step) centres.push(drawnIndices[Math.floor(x)]);
  return {
    wrap,
    waveTurns: turns,
    drawn,
    small,
    wheeled,
    streaming,
    alignment: {
      within30: drawn > 0 ? along.filter((a) => a >= Math.cos(Math.PI / 6)).length / drawn : 0,
      beyond60: drawn > 0 ? along.filter((a) => a < 0.5).length / drawn : 0,
      median: drawn > 0 ? along.sort((a, b) => a - b)[Math.floor(drawn / 2)] : 0,
    },
    returning: back,
    forwardShare: along1 > 0 ? (along1 - back) / along1 : 0,
    returningShare: along1 > 0 ? back / along1 : 0,
    counterFlow: {
      ...skyCounterFlow(strokes.hash, returning, centres),
      radiusDeg: (SKY_COUNTER_FLOW_RADIUS * 180) / Math.PI,
      centres: centres.length,
    },
  };
}

/** The xyz triple at index `s` of `array`. */
function dirAt(array: Float32Array, s: number): [number, number, number] {
  return [array[3 * s], array[3 * s + 1], array[3 * s + 2]];
}
