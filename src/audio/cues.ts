/**
 * The audio cues (plans/phase-6-audio.md) and the runtime manifest P6.4 writes to
 * `public/audio/manifest.json`. A missing or malformed manifest is never an error: the mixer runs
 * silent.
 */

export const CUE_IDS = [
  'score-gallery',
  'score-night',
  'wind-hill',
  'crickets',
  'church-bell',
  'portal-whoosh',
  'stroke-rustle',
] as const;
export type CueId = (typeof CUE_IDS)[number];
export type ScoreId = Extract<CueId, 'score-gallery' | 'score-night'>;

export const SCORE_IDS: readonly ScoreId[] = ['score-gallery', 'score-night'];

export type AudioFormat = 'ogg' | 'mp3';
export type CueKind = 'music' | 'sfx';

/** One cue of P6.4's manifest, as the mixer reads it. */
export interface ManifestCue {
  readonly id: CueId;
  readonly kind: CueKind;
  readonly loop: boolean;
  readonly channels: number | null;
  /** Seconds. */
  readonly duration: number | null;
  /** File names relative to the manifest's own directory, per format. */
  readonly files: Readonly<Partial<Record<AudioFormat, string>>>;
}

export interface AudioManifest {
  readonly version: 1;
  readonly cues: readonly ManifestCue[];
}

/** The manifest's directory under Vite's base: its file names resolve against it. */
export const AUDIO_DIR = 'audio/';
export const MANIFEST_PATH = `${AUDIO_DIR}manifest.json`;
export const MANIFEST_VERSION = 1;

const isCueId = (value: unknown): value is CueId =>
  typeof value === 'string' && (CUE_IDS as readonly string[]).includes(value);

const kindOf = (id: CueId): CueKind =>
  (SCORE_IDS as readonly CueId[]).includes(id) ? 'music' : 'sfx';

const positiveOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** A relative file name with no `..`, no scheme and no leading slash: it stays in AUDIO_DIR. */
const SAFE_FILE = /^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const safeFile = (value: unknown): string | null =>
  typeof value === 'string' && SAFE_FILE.test(value) ? value : null;

/**
 * Validates P6.4's manifest (`{ version: 1, sampleRate, ffmpeg, cues: [{ id, kind, loop, channels,
 * duration, frames, loudness, files: { ogg, mp3 }, bytes, sha256 }] }`). Only the fields the mixer
 * reads are kept. A cue with an unknown id, a kind that does not match its id, no usable file, or a
 * repeated id is dropped, so one bad entry silences only itself. Null when the whole object is not a
 * version-1 manifest; the mixer then runs silent.
 */
export function parseManifest(raw: unknown): AudioManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as { version?: unknown; cues?: unknown };
  if (r.version !== MANIFEST_VERSION || !Array.isArray(r.cues)) return null;
  const cues: ManifestCue[] = [];
  const seen = new Set<CueId>();
  for (const entry of r.cues) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!isCueId(e.id) || seen.has(e.id) || e.kind !== kindOf(e.id)) continue;
    if (typeof e.files !== 'object' || e.files === null) continue;
    const f = e.files as Record<string, unknown>;
    const files: Partial<Record<AudioFormat, string>> = {};
    const ogg = safeFile(f.ogg);
    const mp3 = safeFile(f.mp3);
    if (ogg) files.ogg = ogg;
    if (mp3) files.mp3 = mp3;
    if (!ogg && !mp3) continue;
    seen.add(e.id);
    cues.push({
      id: e.id,
      kind: kindOf(e.id),
      loop: e.loop === true,
      channels: positiveOrNull(e.channels),
      duration: positiveOrNull(e.duration),
      files,
    });
  }
  return { version: MANIFEST_VERSION, cues };
}

/** Opus in Ogg where the browser can decode it (Quest Browser can), else MP3. */
export function pickFormat(canPlayType: (mime: string) => string): AudioFormat {
  return canPlayType('audio/ogg; codecs=opus') !== '' ? 'ogg' : 'mp3';
}

/**
 * The cue's file in `format`, or in the other format when it lacks one, resolved against the
 * manifest's directory under Vite's `base`.
 */
export function cueUrl(cue: ManifestCue, format: AudioFormat, base: string): string | null {
  const file = cue.files[format] ?? cue.files[format === 'ogg' ? 'mp3' : 'ogg'];
  return file ? `${base}${AUDIO_DIR}${file}` : null;
}

/** The score a world plays: the gallery's, the night score in Starry Night, none elsewhere. */
export function scoreFor(worldId: string | null): ScoreId | null {
  if (worldId === 'gallery') return 'score-gallery';
  if (worldId === 'starry-night') return 'score-night';
  return null;
}
