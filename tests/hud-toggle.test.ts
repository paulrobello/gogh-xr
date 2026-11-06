import { describe, expect, it, vi } from 'vitest';
import { createHudToggle, isHudToggleKey, type ToggleableHud } from '../src/ui/hud-toggle';
import { createHudUpdater, type PerfHudValues } from '../src/ui/perf-hud-text';

const VALUES: PerfHudValues = {
  fps: 60,
  meanMs: 16.67,
  p99Ms: 17.1,
  gpuMs: null,
  targetHz: 90,
  visible: 1000,
  visibleChunks: 4,
  governor: null,
};

/** A HUD whose frame() runs the real 4 Hz updater, so redraws are counted on `draw`. */
function fakeHud() {
  const draw = vi.fn<(text: string) => void>();
  const updater = createHudUpdater(draw);
  let fps = VALUES.fps;
  const hud = {
    frame: vi.fn((time: number) => updater.tick(time, () => ({ ...VALUES, fps }))),
    setVisible: vi.fn<(visible: boolean) => void>(),
    diag: () => ({ text: updater.text }),
  } satisfies ToggleableHud;
  return {
    hud,
    draw,
    setFps: (next: number) => {
      fps = next;
    },
  };
}

function setup(visible: boolean) {
  const fake = fakeHud();
  const build = vi.fn(async () => fake.hud);
  const toggle = createHudToggle({ visible, build });
  return { ...fake, build, toggle };
}

/** Lets the build promise settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createHudToggle', () => {
  it('builds nothing before the first show', async () => {
    const { toggle, build } = setup(false);
    for (let t = 0; t <= 2000; t += 16) toggle.frame(t, false);
    await settle();
    expect(build).not.toHaveBeenCalled();
    expect(toggle.visible).toBe(false);
    expect(toggle.diag()).toEqual({ visible: false, built: false });
  });

  it('builds on the first show and shows the built HUD', async () => {
    const { toggle, build, hud } = setup(false);
    toggle.toggle();
    expect(build).toHaveBeenCalledTimes(1);
    expect(toggle.diag()).toEqual({ visible: true, built: false });
    await settle();
    expect(hud.setVisible).toHaveBeenLastCalledWith(true);
    toggle.frame(1000, false);
    expect(toggle.diag()).toEqual({ visible: true, built: true, text: expect.any(String) });
  });

  it('starts building at once when it starts visible (?hud)', async () => {
    const { toggle, build, hud } = setup(true);
    expect(build).toHaveBeenCalledTimes(1);
    await settle();
    expect(hud.setVisible).toHaveBeenLastCalledWith(true);
    expect(toggle.visible).toBe(true);
  });

  it('hides without rebuilding or disposing, and shows the same HUD again', async () => {
    const { toggle, build, hud } = setup(true);
    await settle();
    toggle.toggle();
    expect(hud.setVisible).toHaveBeenLastCalledWith(false);
    toggle.toggle();
    expect(hud.setVisible).toHaveBeenLastCalledWith(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('applies a toggle made while the build is in flight once it lands', async () => {
    const { toggle, build, hud } = setup(true);
    toggle.toggle();
    await settle();
    expect(build).toHaveBeenCalledTimes(1);
    expect(hud.setVisible).toHaveBeenLastCalledWith(false);
    expect(toggle.diag()).toMatchObject({ visible: false, built: true });
  });

  it('retries the build on the next show after a failed build', async () => {
    const onError = vi.fn();
    const fake = fakeHud();
    const build = vi
      .fn<() => Promise<ToggleableHud>>()
      .mockRejectedValueOnce(new Error('no font'))
      .mockResolvedValue(fake.hud);
    const toggle = createHudToggle({ visible: true, build, onError });
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    toggle.toggle();
    toggle.toggle();
    await settle();
    expect(build).toHaveBeenCalledTimes(2);
    expect(toggle.diag()).toMatchObject({ visible: true, built: true });
  });

  it('a hidden HUD does not recompute or redraw', async () => {
    const { toggle, hud, draw, setFps } = setup(true);
    await settle();
    toggle.frame(1000, false);
    expect(draw).toHaveBeenCalledTimes(1);
    toggle.toggle();
    hud.frame.mockClear();
    setFps(30);
    for (let t = 1016; t <= 3000; t += 16) toggle.frame(t, false);
    expect(hud.frame).not.toHaveBeenCalled();
    expect(draw).toHaveBeenCalledTimes(1);
    toggle.toggle();
    toggle.frame(3016, false);
    expect(draw).toHaveBeenCalledTimes(2);
  });
});

describe('setVisible, as the 72 Hz notice calls it (R16, I3)', () => {
  it('builds and shows a hidden, unbuilt HUD, which stays toggleable afterwards', async () => {
    const { toggle, build, hud } = setup(false);
    expect(toggle.diag()).toEqual({ visible: false, built: false });
    toggle.setVisible(true);
    expect(build).toHaveBeenCalledTimes(1);
    await settle();
    expect(hud.setVisible).toHaveBeenLastCalledWith(true);
    expect(toggle.diag()).toMatchObject({ visible: true, built: true });
    toggle.toggle();
    expect(toggle.visible).toBe(false);
    toggle.frame(0, true);
    toggle.frame(16, false);
    expect(toggle.visible).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('re-shows a HUD the user hid, and leaves a shown HUD shown', async () => {
    const { toggle, hud } = setup(true);
    await settle();
    toggle.toggle();
    toggle.setVisible(true);
    expect(toggle.visible).toBe(true);
    expect(hud.setVisible).toHaveBeenLastCalledWith(true);
    toggle.setVisible(true);
    expect(toggle.visible).toBe(true);
  });
});

describe('left X press detection', () => {
  it('toggles once for a press held across frames', async () => {
    const { toggle } = setup(false);
    for (let t = 0; t < 10; t++) toggle.frame(t * 16, true);
    expect(toggle.visible).toBe(true);
  });

  it('toggles again after a release and a new press', () => {
    const { toggle } = setup(false);
    toggle.frame(0, true);
    toggle.frame(16, true);
    toggle.frame(32, false);
    expect(toggle.visible).toBe(true);
    toggle.frame(48, true);
    toggle.frame(64, true);
    expect(toggle.visible).toBe(false);
    toggle.frame(80, false);
    toggle.frame(96, true);
    expect(toggle.visible).toBe(true);
  });
});

describe('isHudToggleKey', () => {
  it('accepts a fresh H press only', () => {
    expect(isHudToggleKey(new KeyboardEvent('keydown', { code: 'KeyH' }))).toBe(true);
    expect(isHudToggleKey(new KeyboardEvent('keydown', { code: 'KeyH', repeat: true }))).toBe(
      false,
    );
    expect(isHudToggleKey(new KeyboardEvent('keydown', { code: 'KeyJ' }))).toBe(false);
  });
});
