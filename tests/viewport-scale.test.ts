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
