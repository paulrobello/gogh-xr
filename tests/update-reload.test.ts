import { describe, expect, it, vi } from 'vitest';
import { parseFlags } from '../src/diag/flags';
import { RELOAD_PARAM, reloadAfterXR, reloadUrl, stripReloadParam } from '../src/update/reload';

describe('update reload URL', () => {
  it('keeps every query parameter and the fragment, and adds a fresh cache buster', () => {
    const href = 'https://gogh-xr.pardev.net/?painting=starry-night&hud&seed=3#view';
    const target = new URL(reloadUrl(href, 1234));
    expect(target.origin + target.pathname).toBe('https://gogh-xr.pardev.net/');
    expect(target.searchParams.get('painting')).toBe('starry-night');
    expect(target.searchParams.has('hud')).toBe(true);
    expect(target.searchParams.get('seed')).toBe('3');
    expect(target.searchParams.get(RELOAD_PARAM)).toBe('1234');
    expect(target.hash).toBe('#view');
  });

  it('replaces an earlier cache buster instead of stacking them', () => {
    const once = reloadUrl('https://host/?a=1#f', 1);
    const twice = new URL(reloadUrl(once, 2));
    expect(twice.searchParams.getAll(RELOAD_PARAM)).toEqual(['2']);
    expect(twice.searchParams.get('a')).toBe('1');
    expect(twice.hash).toBe('#f');
  });

  it('works with no query or fragment', () => {
    expect(reloadUrl('https://host/', 5)).toBe(`https://host/?${RELOAD_PARAM}=5`);
  });

  it('keeps bare flags bare and other parameters byte for byte', () => {
    expect(reloadUrl('https://host/?hud&ab=%20Shimmer%20&motionlayers=sky,moon#x', 3)).toBe(
      `https://host/?hud&ab=%20Shimmer%20&motionlayers=sky,moon&${RELOAD_PARAM}=3#x`,
    );
  });

  it('the new page strips the cache buster and nothing else', () => {
    const reloaded = reloadUrl('https://host/?hud&seed=2#view', 8);
    expect(stripReloadParam(reloaded)).toBe('https://host/?hud&seed=2#view');
    expect(stripReloadParam(`https://host/?${RELOAD_PARAM}=8`)).toBe('https://host/');
    expect(stripReloadParam(`https://host/?${RELOAD_PARAM}=8#f`)).toBe('https://host/#f');
    expect(stripReloadParam('https://host/?a=1#f')).toBe('https://host/?a=1#f');
  });

  it('leaves the flags it carries unchanged', () => {
    const search = new URL(reloadUrl('https://host/?hud&seed=2&turn=smooth', 9)).search;
    const flags = parseFlags(search);
    expect(flags).toEqual({ ...parseFlags('?hud&seed=2&turn=smooth') });
  });
});

describe('reload after XR', () => {
  it('awaits the session end, flushes, then navigates', async () => {
    let finish: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const replace = vi.fn((url: string) => order.push(`replace ${url}`));
    const work = reloadAfterXR(
      () => ended,
      { href: 'https://host/?demo=canvas#view', replace },
      () => order.push('flush'),
      () => 42,
    );
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    finish?.();
    await work;
    expect(order).toEqual([`flush`, `replace https://host/?demo=canvas&${RELOAD_PARAM}=42#view`]);
  });

  it('never navigates when the session will not end', async () => {
    const replace = vi.fn();
    const flush = vi.fn();
    await expect(
      reloadAfterXR(
        () => Promise.reject(new Error('end failed')),
        { href: 'https://host/', replace },
        flush,
      ),
    ).rejects.toThrow('end failed');
    expect(replace).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});
