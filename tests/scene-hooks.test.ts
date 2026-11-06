import { Scene } from 'three';
import { expect, test, vi } from 'vitest';
import { addAfterRender, addBeforeRender } from '../src/render/scene-hooks.ts';

const ARGS = [{}, null, {}, null] as unknown as Parameters<Scene['onBeforeRender']>;

test('hooks run after the original in insertion order and remove in any order', () => {
  const scene = new Scene();
  const calls: string[] = [];
  const original = vi.fn(() => calls.push('original'));
  scene.onBeforeRender = original;
  const removeA = addBeforeRender(scene, () => calls.push('a'));
  const removeB = addBeforeRender(scene, () => calls.push('b'));
  scene.onBeforeRender(...ARGS);
  expect(calls).toEqual(['original', 'a', 'b']);
  removeA();
  removeA();
  calls.length = 0;
  scene.onBeforeRender(...ARGS);
  expect(calls).toEqual(['original', 'b']);
  removeB();
  expect(scene.onBeforeRender).toBe(original);
  // A later add installs afresh.
  const removeC = addBeforeRender(scene, () => calls.push('c'));
  calls.length = 0;
  scene.onBeforeRender(...ARGS);
  expect(calls).toEqual(['original', 'c']);
  removeC();
  expect(scene.onBeforeRender).toBe(original);
});

test('before and after slots are independent', () => {
  const scene = new Scene();
  const before = scene.onBeforeRender;
  const after = scene.onAfterRender;
  const hook = vi.fn();
  const removeBefore = addBeforeRender(scene, hook);
  const removeAfter = addAfterRender(scene, hook);
  removeBefore();
  expect(scene.onBeforeRender).toBe(before);
  expect(scene.onAfterRender).not.toBe(after);
  scene.onAfterRender(...ARGS);
  expect(hook).toHaveBeenCalledTimes(1);
  removeAfter();
  expect(scene.onAfterRender).toBe(after);
});

test('a handler chained over the dispatcher is left in place on the last remove', () => {
  const scene = new Scene();
  const hook = vi.fn();
  const remove = addBeforeRender(scene, hook);
  const dispatch = scene.onBeforeRender;
  const outer = vi.fn((...args: Parameters<Scene['onBeforeRender']>) =>
    dispatch.apply(scene, args),
  );
  scene.onBeforeRender = outer;
  remove();
  expect(scene.onBeforeRender).toBe(outer);
  scene.onBeforeRender(...ARGS);
  expect(hook).not.toHaveBeenCalled();
  // The registry still reaches the scene through the outer handler.
  const again = vi.fn();
  addBeforeRender(scene, again);
  scene.onBeforeRender(...ARGS);
  expect(again).toHaveBeenCalledTimes(1);
});
