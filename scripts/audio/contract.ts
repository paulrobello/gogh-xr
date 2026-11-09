/**
 * The P6.4 runtime audio contract: one entry per cue, plus the validator's limits.
 *
 * Budgets come from plans/phase-6-audio.md ("Runtime audio budget"). The plan gives the
 * -24 LUFS ±2 target for SFX beds only; the one-shots use the same target, which is newly
 * proposed here and recorded as such in docs/audio/derivatives.md. Trim, crossfade and
 * limiter values were chosen from the measured source envelopes recorded there.
 */

export type CueKind = 'music' | 'sfx';

/**
 * A known departure from the contract that only the owner (Paul) can accept. A pending
 * deviation never fails `asset-check`: the validator prints it as a loud WARN on every run,
 * and the cue's provenance status reads "deviation, pending owner decision".
 *
 * - `crest-limited`: the cue reaches its loudness target only through peak limiting. The
 *   skill's rule is linear gain to the ceiling plus a reported shortfall, so `make
 *   audio-audition` renders that linear variant for the owner to compare.
 * - `source-fold`: the 0.5L + 0.5R fold of the stereo source loses more than
 *   `LIMITS.monoMaxLossDb`. The source `mono` failure is waived up to `upToDb`, so a
 *   different (worse) source still fails.
 */
export interface Deviation {
  kind: 'crest-limited' | 'source-fold';
  status: 'pending-owner';
  reason: string;
  upToDb?: number;
}

export interface CueSpec {
  id: string;
  kind: CueKind;
  loop: boolean;
  /** Immutable source, relative to the repo root, with its archived SHA-256. */
  source: { path: string; sha256: string };
  channels: 1 | 2;
  /** Integrated loudness target and tolerance, LUFS / LU. */
  loudness: { target: number; tolerance: number };
  /** Trim window in source seconds. `end: null` keeps the source's end. */
  trim: { start: number; end: number | null };
  /** Tail-to-head crossfade length in seconds (loops only). */
  crossfade?: number;
  /** Linear fade-out at the end, seconds (one-shots only). */
  fadeOut?: number;
  /** Peak limiter for a cue whose crest cannot reach its target by linear gain alone. */
  limiter?: { preGainDb: number; limit: number };
  /** Encoder bitrates, kbit/s. */
  bitrate: { ogg: number; mp3: number };
  /** Fixed Ogg stream serial, so the Ogg bytes are reproducible. */
  serial: number;
  /** Per-file size budget, bytes. */
  maxBytes: number;
  /** Allowed loop length, seconds. */
  duration?: readonly [number, number];
  deviations?: readonly Deviation[];
}

const MIB = 1024 * 1024;
const KIB = 1024;

const MUSIC = {
  kind: 'music',
  loop: true,
  channels: 2,
  loudness: { target: -18, tolerance: 1 },
  bitrate: { ogg: 96, mp3: 112 },
  maxBytes: 3 * MIB,
  duration: [120, 180],
} as const;

const SFX = {
  kind: 'sfx',
  channels: 1,
  loudness: { target: -24, tolerance: 2 },
  bitrate: { ogg: 48, mp3: 64 },
  maxBytes: 512 * KIB,
} as const;

export const CUES: readonly CueSpec[] = [
  {
    ...MUSIC,
    id: 'score-night',
    source: {
      path: 'assets/audio/source/suno/score-night.wav',
      sha256: '445400c6a59f9505412a13ca350a147e47fd5073f5591d438d2328eea8c940fd',
    },
    // The last 4 s fade to digital silence. Ending at 146 s keeps the settling chord.
    trim: { start: 0, end: 146 },
    crossfade: 5,
    serial: 1001,
  },
  {
    ...MUSIC,
    id: 'score-gallery',
    source: {
      path: 'assets/audio/source/suno/score-gallery.wav',
      sha256: '61a26bcad89ecda698d34e63ff5ce7a4b4f35f533ef19158b5a4d3fa82f4b0f9',
    },
    // 124.08 s of source. A 4 s crossfade leaves 120.08 s, inside the 120 s floor.
    trim: { start: 0, end: null },
    crossfade: 4,
    serial: 1002,
  },
  {
    ...SFX,
    id: 'wind-hill',
    loop: true,
    source: {
      path: 'assets/audio/source/elevenlabs/wind-hill-take2.mp3',
      sha256: '0b0ca2bc6c50af9a279a148bb9a715485677385a5379aabff14ad33ce949db6f',
    },
    trim: { start: 0, end: null },
    crossfade: 2,
    // Folded to mono it measures -43.7 LUFS with a -16.3 dBTP peak, so linear gain stops
    // near -29 LUFS. About 5 dB of peak limiting on the gusts reaches the bed target.
    limiter: { preGainDb: 20, limit: 0.7 },
    deviations: [
      {
        kind: 'crest-limited',
        status: 'pending-owner',
        reason:
          'linear gain to the ceiling stops near -29.4 LUFS (about 5.4 LU short), so the shipping file uses about 5 dB of peak limiting on the gusts. Paul picks the limited or the linear render (make audio-audition)',
      },
    ],
    serial: 1003,
  },
  {
    ...SFX,
    id: 'crickets',
    loop: true,
    source: {
      path: 'assets/audio/source/elevenlabs/crickets-take6.mp3',
      sha256: 'd3a076c52a6a76bc9ef0ba7b897794718c1c711f1fba754f93e2868c0599cde1',
    },
    trim: { start: 0, end: null },
    crossfade: 1.5,
    serial: 1004,
  },
  {
    ...SFX,
    id: 'church-bell',
    loop: false,
    source: {
      path: 'assets/audio/source/elevenlabs/church-bell-take2.mp3',
      sha256: '064b665bce72cd17a3ce3449e81237c2f2688ab1b3dc6824a52ed0633ba8b8f5',
    },
    trim: { start: 0, end: null },
    fadeOut: 0.1,
    serial: 1005,
  },
  {
    ...SFX,
    id: 'portal-whoosh',
    loop: false,
    source: {
      path: 'assets/audio/source/elevenlabs/portal-whoosh-take1.mp3',
      sha256: '7a10c9d66613f4d4bd1ad0b7397f3ddd3fd6c162f374b9f8d820d626f3884b1a',
    },
    // The source is more than 60 dB under its peak after 2.0 s.
    trim: { start: 0, end: 2 },
    fadeOut: 0.05,
    deviations: [
      {
        kind: 'source-fold',
        status: 'pending-owner',
        reason:
          'the 0.5L + 0.5R fold of the stereo source loses 2.48 dB against the 2 dB limit. It reads as width loss (uncorrelated stereo is 3.01 dB), not anti-phase cancellation, and the loudness gain restores the level. Paul accepts the mono fold or asks for another take',
        upToDb: 2.6,
      },
    ],
    serial: 1006,
  },
  {
    ...SFX,
    id: 'stroke-rustle',
    loop: false,
    source: {
      path: 'assets/audio/source/elevenlabs/stroke-rustle-take1.mp3',
      sha256: '452474a08b9819c1d81af45f40346d7fb15abdcba0a299fa0f3cc3afc09d35e1',
    },
    // The source is more than 30 dB under its body after 0.9 s.
    trim: { start: 0, end: 0.9 },
    fadeOut: 0.03,
    serial: 1007,
  },
];

export interface Limits {
  /** Decoded true peak ceiling for every runtime file, dBTP. */
  truePeakMax: number;
  /** Half-width of the window across the loop wrap, seconds. */
  seamHalfWindowS: number;
  /** Corner of the seam check's low band, Hz. */
  seamLowpassHz: number;
  /** Largest allowed seam-window statistic over the loop's own p99.9 window statistic. */
  wrapMaxRatio: number;
  /** Head and tail RMS windows for the loop energy balance, seconds. */
  headTailWindowS: number;
  /** Largest allowed head-to-tail RMS difference, dB. */
  headTailMaxDb: number;
  /** Window for the interior quiet-gap scan, seconds. */
  gapWindowS: number;
  /** A window this far below the loop's median window level is a gap, dB. */
  gapBelowMedianDb: number;
  /** A run of exact digital zeros at least this long is a gap, seconds. */
  zeroRunS: number;
  /** A one-shot's active span starts and ends at this sample level, dBFS. */
  activeFloorDb: number;
  /** Largest allowed level loss of the 0.5L + 0.5R fold against the channel mean, dB. */
  monoMaxLossDb: number;
}

export const LIMITS: Limits = {
  truePeakMax: -1,
  // ±6 ms, not ±2 ms: the review's impulse 5 ms before the score-night seam sits outside ±2 ms.
  seamHalfWindowS: 0.006,
  seamLowpassHz: 1000,
  // The shipping loops peak at 0.89 (full band) and 0.73 (low band). The review's seam
  // mutations measure 2.35 and up.
  wrapMaxRatio: 1.5,
  headTailWindowS: 1,
  headTailMaxDb: 6,
  gapWindowS: 0.1,
  gapBelowMedianDb: 24,
  zeroRunS: 0.01,
  activeFloorDb: -60,
  monoMaxLossDb: 2,
};

/** The master's true-peak target before encoding, leaving room for codec overshoot. */
export const MASTER_TRUE_PEAK_CEILING = -2;
