/**
 * The painting registry (PRD D14, P5.1): the live Starry Night and the six coming-soon paintings.
 * `validateRegistry` checks it at boot (structure) and in tests (structure, frame files and
 * PROVENANCE.md keys).
 */
import type { WorldModule } from './world-module';

export interface PaintingEntry {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly museum: string;
  /** Key of the painting's row in assets/PROVENANCE.md. */
  readonly scanProvenance: string;
  /** Framed scan under public/, relative to the base URL. */
  readonly frameImage: string;
  /** The painting's real width in cm, so P5.4 hangs the frames at true relative scale. */
  readonly widthCm: number;
  /** The painting's real height in cm. */
  readonly heightCm: number;
  /** Where the size comes from. Not shown anywhere. */
  readonly sizeSource: string;
  readonly status: 'live' | 'coming-soon';
  readonly world?: () => Promise<WorldModule>;
}

const COMMONS = 'Wikimedia Commons file page (artwork dimensions, see assets/PROVENANCE.md)';

export const PAINTINGS: readonly PaintingEntry[] = Object.freeze(
  (
    [
      {
        id: 'starry-night',
        title: 'The Starry Night',
        year: 1889,
        museum: 'Museum of Modern Art, New York',
        scanProvenance: 'starry-night',
        frameImage: 'paintings/starry-night/frame.webp',
        widthCm: 92.1,
        heightCm: 73.7,
        sizeSource: 'MoMA collection page, 73.7 x 92.1 cm (h x w)',
        status: 'live',
        world: () => import('./starry-night/index'),
      },
      {
        id: 'chestnut-trees-in-blossom',
        title: 'Blossoming Chestnut Trees',
        year: 1890,
        museum: 'Kröller-Müller Museum, Otterlo',
        scanProvenance: 'chestnut-trees-in-blossom',
        frameImage: 'paintings/chestnut-trees-in-blossom/frame.webp',
        widthCm: 50.5,
        heightCm: 63,
        sizeSource: `${COMMONS}: 63 x 50.5 cm (h x w), F752`,
        status: 'coming-soon',
      },
      {
        id: 'les-alyscamps',
        title: 'Les Alyscamps',
        year: 1888,
        museum: 'Private collection',
        scanProvenance: 'les-alyscamps',
        frameImage: 'paintings/les-alyscamps/frame.webp',
        widthCm: 73.5,
        heightCm: 91.7,
        sizeSource: `${COMMONS}: 91.7 x 73.5 cm (h x w), Sotheby's lot 18`,
        status: 'coming-soon',
      },
      {
        id: 'cafe-terrace-at-night',
        title: 'Café Terrace at Night',
        year: 1888,
        museum: 'Kröller-Müller Museum, Otterlo',
        scanProvenance: 'cafe-terrace-at-night',
        frameImage: 'paintings/cafe-terrace-at-night/frame.webp',
        widthCm: 65.5,
        heightCm: 81,
        sizeSource: `${COMMONS} (Yorck file page): 81 x 65.5 cm (h x w)`,
        status: 'coming-soon',
      },
      {
        id: 'bedroom',
        title: 'The Bedroom',
        year: 1888,
        museum: 'Van Gogh Museum, Amsterdam',
        scanProvenance: 'bedroom',
        frameImage: 'paintings/bedroom/frame.webp',
        widthCm: 91.3,
        heightCm: 72.4,
        sizeSource: `Wikidata Q18713070 (height 72.4, width 91.3 cm); the Commons caption says 72 x 90`,
        status: 'coming-soon',
      },
      {
        id: 'wheatfield-with-crows',
        title: 'Wheatfield with Crows',
        year: 1890,
        museum: 'Van Gogh Museum, Amsterdam',
        scanProvenance: 'wheatfield-with-crows',
        frameImage: 'paintings/wheatfield-with-crows/frame.webp',
        widthCm: 103,
        heightCm: 50.2,
        sizeSource: `Wikidata Q634122 (height 50.2, width 103 cm)`,
        status: 'coming-soon',
      },
      {
        id: 'starry-night-over-the-rhone',
        title: 'Starry Night Over the Rhône',
        year: 1888,
        museum: "Musée d'Orsay, Paris",
        scanProvenance: 'starry-night-over-the-rhone',
        frameImage: 'paintings/starry-night-over-the-rhone/frame.webp',
        widthCm: 92,
        heightCm: 72.5,
        sizeSource: `${COMMONS}: 72.5 x 92 cm (h x w), Wikidata Q1464531`,
        status: 'coming-soon',
      },
    ] satisfies PaintingEntry[]
  ).map((entry) => Object.freeze(entry)),
);

export type RegistryProblemCode =
  | 'empty-field'
  | 'bad-year'
  | 'bad-size'
  | 'bad-status'
  | 'duplicate-id'
  | 'live-without-world'
  | 'unknown-provenance'
  | 'missing-frame-image';

export interface RegistryProblem {
  readonly id: string;
  readonly code: RegistryProblemCode;
  readonly status: PaintingEntry['status'];
  readonly message: string;
}

export interface RegistryChecks {
  /** Whether `frameImage` (relative to public/) exists. Omit to skip the check, as at boot. */
  readonly frameExists?: (frameImage: string) => boolean;
  /** The keys PROVENANCE.md defines. Omit to skip the check, as at boot. */
  readonly provenanceKeys?: ReadonlySet<string>;
}

/** Every problem in `entries`, in entry order. Never throws, so a bad entry cannot stop a boot. */
export function validateRegistry(
  entries: readonly PaintingEntry[],
  checks: RegistryChecks = {},
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const add = (code: RegistryProblemCode, message: string): void => {
      problems.push({ id: String(entry.id), code, status: entry.status, message });
    };
    const text = (field: 'id' | 'title' | 'museum' | 'scanProvenance' | 'frameImage'): boolean => {
      const value = entry[field];
      if (typeof value === 'string' && value.trim() !== '') return true;
      add('empty-field', `${field} is empty`);
      return false;
    };
    if (text('id')) {
      if (seen.has(entry.id)) add('duplicate-id', `id "${entry.id}" is used twice`);
      seen.add(entry.id);
    }
    text('title');
    text('museum');
    const hasProvenance = text('scanProvenance');
    const hasFrame = text('frameImage');
    if (!Number.isInteger(entry.year) || entry.year < 1800 || entry.year > 1900) {
      add('bad-year', `year ${String(entry.year)} is not a whole year in 1800-1900`);
    }
    for (const field of ['widthCm', 'heightCm'] as const) {
      const value = entry[field];
      if (!Number.isFinite(value) || value <= 0) {
        add('bad-size', `${field} ${String(value)} is not a positive number`);
      }
    }
    if (entry.status !== 'live' && entry.status !== 'coming-soon') {
      add('bad-status', `status "${String(entry.status)}" is neither live nor coming-soon`);
    }
    if (entry.status === 'live' && typeof entry.world !== 'function') {
      add('live-without-world', 'a live entry needs a world import');
    }
    if (
      checks.provenanceKeys &&
      hasProvenance &&
      !checks.provenanceKeys.has(entry.scanProvenance)
    ) {
      add(
        'unknown-provenance',
        `scanProvenance "${entry.scanProvenance}" has no row in assets/PROVENANCE.md`,
      );
    }
    if (checks.frameExists && hasFrame && !checks.frameExists(entry.frameImage)) {
      add('missing-frame-image', `frameImage "${entry.frameImage}" does not exist under public/`);
    }
  }
  return problems;
}

/** Boot-time check: logs every problem. Structure only, the file checks run in tests. */
export function logRegistryProblems(entries: readonly PaintingEntry[] = PAINTINGS): void {
  for (const problem of validateRegistry(entries)) {
    console.warn(
      `painting registry: ${problem.id} (${problem.status}): ${problem.code}: ${problem.message}`,
    );
  }
}

/**
 * The live entry with a world for `id`. Null for no id; an unknown or coming-soon id also logs a
 * warning and returns null, so the boot ignores it and, with no other scene flag, opens the gallery
 * (src/boot-mode.ts).
 */
export function livePainting(id: string | null): PaintingEntry | null {
  if (id === null) return null;
  const entry = PAINTINGS.find((p) => p.id === id);
  if (entry?.status === 'live' && entry.world) return entry;
  console.warn(`painting "${id}" is ${entry ? 'not live yet' : 'unknown'}; ignoring it`);
  return null;
}
