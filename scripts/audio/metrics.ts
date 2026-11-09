/**
 * Sample-domain checks on decoded PCM (P6.4). Pure functions, so they run without ffmpeg.
 *
 * A loop fails audibly in independent ways (see the create-game-audio-assets skill): the
 * wrap step, the head-to-tail level, and dropouts inside the body. Each has its own measure.
 */

export interface PcmLike {
  sampleRate: number;
  channels: Float32Array[];
  frames: number;
}

export interface SeamOptions {
  /** Half-width of the window across the wrap, seconds. */
  halfWindowS: number;
  /** Corner of the low band, Hz. */
  lowpassHz: number;
}

export interface SeamBand {
  /** Largest |x[i] - x[i-1]| inside the seam window, worst channel. */
  seam: number;
  /** p99.9 of the same statistic over every other window of the loop, that channel. */
  p999: number;
  /** seam / p999. */
  ratio: number;
}

export interface WrapResult {
  /** The raw signal, which shows a step or an impulse near the seam. */
  full: SeamBand;
  /**
   * The signal through a 2-pole low-pass. A short click keeps its low-frequency energy
   * after lossy coding smears its peak, and a high-frequency bed (crickets) has little
   * there, so a click hidden in the full band stands out in this one.
   */
  low: SeamBand;
  /** The larger of the two ratios. */
  ratio: number;
}

/** RBJ biquad low-pass, Q = 1/sqrt(2), run once over `x`. */
function lowpass(x: Float32Array, hz: number, sampleRate: number): Float32Array {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    const out = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
}

/**
 * Seam statistics on `ext`, a channel extended so that ext[pre + i] = x[i] and the
 * `pre` frames before it are the loop's own tail. The seam window is
 * [pre - half, pre + half), centred on the wrap.
 */
function seamBand(ext: Float32Array, pre: number, frames: number, half: number): SeamBand {
  const maxStep = (from: number, to: number) => {
    let m = 0;
    for (let i = from; i < to; i++) {
      const step = Math.abs((ext[i] as number) - (ext[i - 1] as number));
      if (step > m) m = step;
    }
    return m;
  };
  const seam = maxStep(pre - half, pre + half);
  const maxima: number[] = [];
  for (let start = pre + half; start + 2 * half <= pre + frames - half; start += 2 * half) {
    maxima.push(maxStep(start, start + 2 * half));
  }
  maxima.sort((a, b) => a - b);
  const p999 = maxima[Math.min(maxima.length - 1, Math.floor(0.999 * maxima.length))] ?? 0;
  const ratio = p999 > 0 ? seam / p999 : seam > 0 ? Infinity : 0;
  return { seam, p999, ratio };
}

/**
 * The end-to-start discontinuity, over a window across the wrap rather than one sample
 * pair, in the full band and a low band. Each is compared with the loop's own window
 * statistics, so a busy bed tolerates more motion than a smooth pad.
 */
export function wrapStep(pcm: PcmLike, options: SeamOptions): WrapResult {
  const half = Math.max(1, Math.round(options.halfWindowS * pcm.sampleRate));
  // Enough of the tail ahead of the head for the low-pass to settle before the window.
  const pre = Math.min(pcm.frames, half + Math.round(0.1 * pcm.sampleRate));
  let full: SeamBand = { seam: 0, p999: 0, ratio: 0 };
  let low: SeamBand = { seam: 0, p999: 0, ratio: 0 };
  for (const ch of pcm.channels) {
    if (ch.length < 4 * half + pre) continue;
    const ext = new Float32Array(pre + ch.length);
    ext.set(ch.subarray(ch.length - pre), 0);
    ext.set(ch, pre);
    const f = seamBand(ext, pre, ch.length, half);
    const l = seamBand(lowpass(ext, options.lowpassHz, pcm.sampleRate), pre, ch.length, half);
    if (f.ratio >= full.ratio) full = f;
    if (l.ratio >= low.ratio) low = l;
  }
  return { full, low, ratio: Math.max(full.ratio, low.ratio) };
}

function db(power: number): number {
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}

/** Mean power over all channels of frames [start, end). */
function power(pcm: PcmLike, start: number, end: number): number {
  let sum = 0;
  for (const ch of pcm.channels) {
    for (let i = start; i < end; i++) sum += (ch[i] as number) ** 2;
  }
  const count = (end - start) * pcm.channels.length;
  return count > 0 ? sum / count : 0;
}

export interface HeadTailResult {
  headDb: number;
  tailDb: number;
  deltaDb: number;
}

/** RMS of the first and last `windowS` seconds, all channels. */
export function headTailBalance(pcm: PcmLike, windowS: number): HeadTailResult {
  const n = Math.min(pcm.frames, Math.round(windowS * pcm.sampleRate));
  const headDb = db(power(pcm, 0, n));
  const tailDb = db(power(pcm, pcm.frames - n, pcm.frames));
  return { headDb, tailDb, deltaDb: headDb === tailDb ? 0 : Math.abs(headDb - tailDb) };
}

export interface GapOptions {
  windowS: number;
  belowMedianDb: number;
  zeroRunS: number;
  /** Loops scan every window and the whole file. One-shots scan only exact-zero runs inside their active span. */
  loop: boolean;
  activeFloorDb: number;
}

export interface GapResult {
  medianDb: number;
  /** Start times (s) and levels (dB) of windows more than `belowMedianDb` under the median. */
  quiet: { at: number; db: number }[];
  /** Longest run of frames that are exactly zero in every channel, seconds. */
  longestZeroRunS: number;
  zeroRunAt: number;
}

export function interiorGaps(pcm: PcmLike, options: GapOptions): GapResult {
  const quiet: { at: number; db: number }[] = [];
  let medianDb = Number.NaN;
  if (options.loop) {
    const window = Math.max(1, Math.round(options.windowS * pcm.sampleRate));
    const levels: { at: number; db: number }[] = [];
    for (let start = 0; start + window <= pcm.frames; start += window) {
      levels.push({ at: start / pcm.sampleRate, db: db(power(pcm, start, start + window)) });
    }
    const sorted = levels.map((l) => l.db).sort((a, b) => a - b);
    medianDb = sorted[Math.floor(sorted.length / 2)] ?? -Infinity;
    for (const level of levels) {
      if (level.db < medianDb - options.belowMedianDb) quiet.push(level);
    }
  }

  let first = 0;
  let last = pcm.frames - 1;
  if (!options.loop) {
    const floor = 10 ** (options.activeFloorDb / 20);
    const loud = (i: number) => pcm.channels.some((ch) => Math.abs(ch[i] as number) > floor);
    while (first < pcm.frames && !loud(first)) first++;
    while (last > first && !loud(last)) last--;
  }
  let longest = 0;
  let longestAt = 0;
  let run = 0;
  for (let i = first; i <= last; i++) {
    const zero = pcm.channels.every((ch) => ch[i] === 0);
    run = zero ? run + 1 : 0;
    if (run > longest) {
      longest = run;
      longestAt = i - run + 1;
    }
  }
  return {
    medianDb,
    quiet,
    longestZeroRunS: longest / pcm.sampleRate,
    zeroRunAt: longestAt / pcm.sampleRate,
  };
}

export interface MonoResult {
  /** Mean channel power, dB. */
  channelDb: number;
  /** Power of the 0.5L + 0.5R fold, dB. */
  foldDb: number;
  /** channelDb - foldDb. 0 for identical channels, about 3 for uncorrelated, large for anti-phase. */
  lossDb: number;
}

/**
 * Mono compatibility by explicit 0.5L + 0.5R arithmetic, against the mean channel power.
 * An automatic downmix (ffmpeg `-ac 1`) compensates gain and hides cancellation, and a
 * stereo-versus-mono R128 comparison carries a 3 dB channel-sum offset; this avoids both.
 * A mono file has nothing to fold and reports 0.
 */
export function monoFold(pcm: PcmLike): MonoResult {
  if (pcm.channels.length < 2) {
    const channelDb = db(power(pcm, 0, pcm.frames));
    return { channelDb, foldDb: channelDb, lossDb: 0 };
  }
  const left = pcm.channels[0] as Float32Array;
  const right = pcm.channels[1] as Float32Array;
  let channel = 0;
  let fold = 0;
  for (let i = 0; i < pcm.frames; i++) {
    const l = left[i] as number;
    const r = right[i] as number;
    channel += (l * l + r * r) / 2;
    fold += (0.5 * l + 0.5 * r) ** 2;
  }
  const channelDb = db(channel / pcm.frames);
  const foldDb = db(fold / pcm.frames);
  return { channelDb, foldDb, lossDb: channel > 0 ? channelDb - foldDb : 0 };
}
