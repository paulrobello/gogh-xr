// @vitest-environment node
/**
 * Ties the contract's pending-owner deviations (scripts/audio/contract.ts) to the cue status in
 * docs/audio/provenance.md. The validator only prints a WARN for a deviation, so without this a
 * deviation could be added or accepted in one file and left stale in the other.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUES, type CueSpec } from '../scripts/audio/contract.ts';

// These literal phrases tie the test to the wording of docs/audio/provenance.md. Rewording a
// deviation row there means updating them here.
const PENDING = /^deviation, pending owner decision/i;
/** Words the provenance row must carry for each deviation kind, so the wrong kind is caught too. */
const KIND_WORDS: Record<string, RegExp> = {
  'crest-limited': /peak limiting/i,
  'source-fold': /fold/i,
};

/** The "Technical preparation" cell of every cue column, from each table headed `| Status | <cue ids> |`. */
function technicalPreparation(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let ids: string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      ids = null;
      continue;
    }
    const cells = line
      .slice(1, line.lastIndexOf('|'))
      .split('|')
      .map((c) => c.trim());
    if (cells[0] === 'Status') {
      ids = cells.slice(1);
    } else if (ids && cells[0]?.startsWith('Technical preparation')) {
      ids.forEach((id, i) => {
        out.set(id, cells[i + 1] ?? '');
      });
    }
  }
  return out;
}

/** Every way the contract's deviations and the provenance statuses disagree. Empty when they agree. */
function deviationDisagreements(cues: readonly CueSpec[], markdown: string): string[] {
  const rows = technicalPreparation(markdown);
  const problems: string[] = [];
  for (const cue of cues) {
    const row = rows.get(cue.id);
    if (row === undefined) {
      problems.push(`${cue.id}: no "Technical preparation" row in provenance.md`);
      continue;
    }
    const pending = (cue.deviations ?? []).filter((d) => d.status === 'pending-owner');
    const marked = PENDING.test(row.replace(/^P6\.4:\s*/, ''));
    if (pending.length > 0 && !marked) {
      problems.push(
        `${cue.id}: contract has a pending-owner deviation (${pending.map((d) => d.kind).join(', ')}) but provenance.md does not say "Deviation, pending owner decision"`,
      );
    }
    if (pending.length === 0 && marked) {
      problems.push(
        `${cue.id}: provenance.md says "Deviation, pending owner decision" but the contract has no pending-owner deviation`,
      );
    }
    for (const d of pending) {
      const words = KIND_WORDS[d.kind];
      if (marked && words && !words.test(row)) {
        problems.push(`${cue.id}: provenance.md does not describe the ${d.kind} deviation`);
      }
    }
  }
  for (const id of rows.keys()) {
    if (!cues.some((c) => c.id === id))
      problems.push(`${id}: provenance.md names a cue the contract lacks`);
  }
  return problems;
}

const provenance = readFileSync(
  resolve(import.meta.dirname, '../docs/audio/provenance.md'),
  'utf8',
);

describe('audio deviations versus provenance', () => {
  it('agree for every cue in the repo', () => {
    expect(deviationDisagreements(CUES, provenance)).toEqual([]);
  });

  it('reads a status for each of the seven cues', () => {
    expect([...technicalPreparation(provenance).keys()].sort()).toEqual(
      CUES.map((c) => c.id).sort(),
    );
  });

  it('fails when a contract deviation is missing from provenance', () => {
    const accepted = provenance.replace(/Deviation, pending owner decision \(P6\.4\)/g, 'P6.4');
    const problems = deviationDisagreements(CUES, accepted);
    expect(problems.some((p) => p.startsWith('wind-hill:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('portal-whoosh:'))).toBe(true);
  });

  it('fails when provenance marks a cue the contract no longer deviates', () => {
    const resolved = CUES.map((c) => (c.id === 'wind-hill' ? { ...c, deviations: [] } : c));
    const problems = deviationDisagreements(resolved, provenance);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^wind-hill: provenance\.md says/);
  });

  it('fails when provenance marks a different cue', () => {
    const moved = provenance.replace(
      /\| P6\.4: 10\.000 s mono one-shot\./,
      '| Deviation, pending owner decision (P6.4): 10.000 s mono one-shot.',
    );
    const problems = deviationDisagreements(CUES, moved);
    expect(problems.some((p) => p.startsWith('church-bell:'))).toBe(true);
  });
});
