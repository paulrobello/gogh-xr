/**
 * Per-scene `onBeforeRender` / `onAfterRender` hook registry. Each owner adds its own hook and
 * removes it with the returned function, in any order, without capturing and restoring the
 * scene's handler itself. The first add installs one dispatcher that calls the scene's original
 * handler, then every hook in insertion order. The last remove restores the original handler,
 * unless something else has replaced the dispatcher since, which then stays as a no-op.
 */
import type { Scene } from 'three';

type Slot = 'onBeforeRender' | 'onAfterRender';
export type SceneRenderHook = (...args: Parameters<Scene['onBeforeRender']>) => void;

interface Registry {
  readonly hooks: SceneRenderHook[];
  readonly original: Scene[Slot];
  readonly dispatch: Scene[Slot];
}

const registries = new WeakMap<Scene, Partial<Record<Slot, Registry>>>();

function addHook(scene: Scene, slot: Slot, hook: SceneRenderHook): () => void {
  const slots = registries.get(scene) ?? {};
  registries.set(scene, slots);
  let registry = slots[slot];
  if (!registry) {
    const hooks: SceneRenderHook[] = [];
    const original = scene[slot];
    const dispatch = function (this: Scene, ...args: Parameters<Scene['onBeforeRender']>) {
      original.apply(this, args);
      for (let i = 0; i < hooks.length; i++) hooks[i](...args);
    };
    registry = { hooks, original, dispatch };
    slots[slot] = registry;
    scene[slot] = dispatch;
  }
  // A fresh entry per add, so adding one function twice needs two removes.
  const entry: SceneRenderHook = (...args) => hook(...args);
  const current = registry;
  current.hooks.push(entry);
  return () => {
    const i = current.hooks.indexOf(entry);
    if (i < 0) return;
    current.hooks.splice(i, 1);
    if (current.hooks.length > 0 || scene[slot] !== current.dispatch) return;
    scene[slot] = current.original;
    if (slots[slot] === current) delete slots[slot];
  };
}

/** Runs `hook` in `scene.onBeforeRender`; returns its remove function, safe to call twice. */
export function addBeforeRender(scene: Scene, hook: SceneRenderHook): () => void {
  return addHook(scene, 'onBeforeRender', hook);
}

/** Runs `hook` in `scene.onAfterRender`; returns its remove function, safe to call twice. */
export function addAfterRender(scene: Scene, hook: SceneRenderHook): () => void {
  return addHook(scene, 'onAfterRender', hook);
}
