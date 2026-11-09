/**
 * public/audio/manifest.json, the interface the P6.5 mixer reads. Its shape is documented in
 * CLAUDE.md (Audio). File names are relative to the manifest's own directory.
 */
import type { CueKind, CueSpec } from './contract.ts';

export const MANIFEST_NAME = 'manifest.json';

export interface ManifestCue {
  id: string;
  kind: CueKind;
  loop: boolean;
  channels: 1 | 2;
  /** Decoded length, seconds (frames / sampleRate). */
  duration: number;
  /** Decoded length, frames at `sampleRate`. Every runtime file decodes to exactly this. */
  frames: number;
  /** Integrated loudness target and tolerance, LUFS / LU. */
  loudness: { target: number; tolerance: number };
  files: { ogg: string; mp3: string };
  bytes: { ogg: number; mp3: number };
  sha256: { ogg: string; mp3: string };
}

export interface Manifest {
  version: 1;
  sampleRate: number;
  ffmpeg: string;
  cues: ManifestCue[];
}

export interface ManifestInput {
  spec: CueSpec;
  frames: number;
  files: Record<'ogg' | 'mp3', { name: string; bytes: number; sha256: string }>;
}

export function manifestCue(input: ManifestInput, sampleRate = 48_000): ManifestCue {
  const { spec, frames, files } = input;
  return {
    id: spec.id,
    kind: spec.kind,
    loop: spec.loop,
    channels: spec.channels,
    duration: frames / sampleRate,
    frames,
    loudness: { target: spec.loudness.target, tolerance: spec.loudness.tolerance },
    files: { ogg: files.ogg.name, mp3: files.mp3.name },
    bytes: { ogg: files.ogg.bytes, mp3: files.mp3.bytes },
    sha256: { ogg: files.ogg.sha256, mp3: files.mp3.sha256 },
  };
}

export function buildManifest(
  inputs: readonly ManifestInput[],
  ffmpeg: string,
  sampleRate = 48_000,
): Manifest {
  return {
    version: 1,
    sampleRate,
    ffmpeg,
    cues: inputs.map((input) => manifestCue(input, sampleRate)),
  };
}
