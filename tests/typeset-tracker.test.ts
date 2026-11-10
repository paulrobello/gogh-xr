import { describe, expect, it } from 'vitest';
import { createTypesetTracker } from '../src/ui/typeset-tracker';

describe('typeset tracker', () => {
  it('starts untypeset and the first sync typesets the built texts', () => {
    const t = createTypesetTracker();
    expect(t.typeset).toBe(false);
    let finish = (): void => {};
    t.sync((done) => {
      finish = done;
    });
    expect(t.typeset).toBe(false);
    finish();
    expect(t.typeset).toBe(true);
  });

  it('a sync with no text changed neither runs troika nor drops typeset', () => {
    const t = createTypesetTracker();
    t.sync((done) => done());
    let runs = 0;
    t.sync(() => {
      runs++;
    });
    expect(runs).toBe(0);
    expect(t.typeset).toBe(true);
  });

  it('a changed text drops typeset until its callback fires', () => {
    const t = createTypesetTracker();
    t.sync((done) => done());
    t.markDirty();
    let finish = (): void => {};
    t.sync((done) => {
      finish = done;
    });
    expect(t.typeset).toBe(false);
    finish();
    expect(t.typeset).toBe(true);
  });

  it('a superseded sync callback does not report the later texts typeset', () => {
    const t = createTypesetTracker();
    let first = (): void => {};
    t.sync((done) => {
      first = done;
    });
    t.markDirty();
    let second = (): void => {};
    t.sync((done) => {
      second = done;
    });
    first();
    expect(t.typeset).toBe(false);
    second();
    expect(t.typeset).toBe(true);
  });
});
