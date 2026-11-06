import { expect, test, vi } from 'vitest';
import { installViewportScale } from '../src/xr/viewport-scale.ts';

const VIEW_PROTO = { requestViewportScale() {} };

function view() {
  return { requestViewportScale: vi.fn() };
}

test('base-layer path: getViewport requests the scale on the view before reading it', () => {
  const calls: string[] = [];
  const layer = {
    getViewport(this: unknown, _v: unknown) {
      calls.push('getViewport');
      return { x: 0, y: 0, width: 100, height: 100, self: this };
    },
  };
  const scaler = installViewportScale(
    { getBaseLayer: () => layer, getBinding: () => null },
    VIEW_PROTO,
  );
  expect(scaler.path).toBe('base-layer');
  const v = { requestViewportScale: vi.fn(() => calls.push('scale')) };
  scaler.scale = 0.85;
  const viewport = layer.getViewport(v) as unknown as { self: unknown };
  expect(v.requestViewportScale).toHaveBeenCalledWith(0.85);
  expect(viewport.self).toBe(layer);
  expect(calls).toEqual(['scale', 'getViewport']);
  scaler.uninstall();
  const after = view();
  layer.getViewport(after);
  expect(after.requestViewportScale).not.toHaveBeenCalled();
});

test('projection-layer path: getViewSubImage(layer, view) requests the scale first', () => {
  const projection = {};
  const binding = { getViewSubImage: vi.fn(() => ({ viewport: {} })) };
  const scaler = installViewportScale(
    { getBaseLayer: () => projection, getBinding: () => binding },
    VIEW_PROTO,
  );
  expect(scaler.path).toBe('projection-layer');
  const v = view();
  (binding.getViewSubImage as (layer: unknown, view: unknown) => unknown)(projection, v);
  expect(v.requestViewportScale).toHaveBeenCalledWith(1);
  scaler.uninstall();
  expect(Object.hasOwn(binding, 'getViewSubImage')).toBe(true);
});

test('unavailable without requestViewportScale or without a layer; setting the scale is a no-op', () => {
  const layer = { getViewport: vi.fn() };
  const noView = installViewportScale({ getBaseLayer: () => layer, getBinding: () => null }, {});
  expect(noView.path).toBe('unavailable');
  noView.scale = 0.85;
  const noLayer = installViewportScale(
    { getBaseLayer: () => null, getBinding: () => null },
    VIEW_PROTO,
  );
  expect(noLayer.path).toBe('unavailable');
});

test('the scale must be in (0, 1]', () => {
  const scaler = installViewportScale(
    { getBaseLayer: () => null, getBinding: () => null },
    VIEW_PROTO,
  );
  expect(() => {
    scaler.scale = 0;
  }).toThrow(RangeError);
  expect(() => {
    scaler.scale = 1.2;
  }).toThrow(RangeError);
});

/** A view whose requested scale the fake runtime reads back, as a real XRView does. */
function scalableView() {
  return {
    requested: 1,
    requestViewportScale(scale: number) {
      this.requested = scale;
    },
  };
}

type FakeView = ReturnType<typeof scalableView>;

test('base-layer path: applied is null until measured, then tracks the honoured width', () => {
  const layer = {
    getViewport: (v: FakeView) => ({
      x: 0,
      y: 0,
      width: Math.round(1680 * v.requested),
      height: 1760,
    }),
  };
  const scaler = installViewportScale(
    { getBaseLayer: () => layer, getBinding: () => null },
    VIEW_PROTO,
  );
  expect(scaler.applied).toBeNull();
  const v = scalableView();
  expect(layer.getViewport(v).width).toBe(1680);
  expect(scaler.applied).toBe(1);
  scaler.scale = 0.85;
  expect(layer.getViewport(v).width).toBe(1428);
  expect(scaler.scale).toBe(0.85);
  expect(scaler.applied).toBeCloseTo(0.85, 10);
  scaler.scale = 1;
  layer.getViewport(v);
  expect(scaler.applied).toBe(1);
});

test('base-layer path: a runtime that ignores the request reports applied 1', () => {
  const layer = { getViewport: (_v: FakeView) => ({ x: 0, y: 0, width: 1680, height: 1760 }) };
  const scaler = installViewportScale(
    { getBaseLayer: () => layer, getBinding: () => null },
    VIEW_PROTO,
  );
  const v = scalableView();
  layer.getViewport(v);
  scaler.scale = 0.85;
  layer.getViewport(v);
  expect(scaler.scale).toBe(0.85);
  expect(scaler.applied).toBe(1);
});

test('projection-layer path: applied reads subImage.viewport.width, honoured or ignored', () => {
  for (const honours of [true, false]) {
    const projection = {};
    const binding = {
      getViewSubImage: (_layer: unknown, v: FakeView) => ({
        viewport: {
          x: 0,
          y: 0,
          width: Math.round(2064 * (honours ? v.requested : 1)),
          height: 2208,
        },
      }),
    };
    const scaler = installViewportScale(
      { getBaseLayer: () => projection, getBinding: () => binding },
      VIEW_PROTO,
    );
    expect(scaler.path).toBe('projection-layer');
    const v = scalableView();
    binding.getViewSubImage(projection, v);
    scaler.scale = 0.85;
    const sub = binding.getViewSubImage(projection, v);
    expect(sub.viewport.width).toBe(honours ? 1754 : 2064);
    expect(scaler.applied).toBeCloseTo(honours ? 1754 / 2064 : 1, 10);
    scaler.uninstall();
  }
});

test('applied stays null without a scale-1 baseline, or when the result has no width', () => {
  const layer = { getViewport: (_v: FakeView) => ({ x: 0, y: 0, width: 1428, height: 1760 }) };
  const scaler = installViewportScale(
    { getBaseLayer: () => layer, getBinding: () => null },
    VIEW_PROTO,
  );
  scaler.scale = 0.85;
  layer.getViewport(scalableView());
  expect(scaler.applied).toBeNull();

  const projection = {};
  const binding = { getViewSubImage: (_layer: unknown, _v: unknown) => ({ viewport: {} }) };
  const noWidth = installViewportScale(
    { getBaseLayer: () => projection, getBinding: () => binding },
    VIEW_PROTO,
  );
  binding.getViewSubImage(projection, scalableView());
  expect(noWidth.applied).toBeNull();
});
