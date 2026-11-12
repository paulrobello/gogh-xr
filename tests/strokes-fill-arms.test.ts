import { DataTexture, InstancedBufferGeometry, type Object3D, RGBAFormat } from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAbGroup, resolveAb } from '../src/diag/ab.ts';
import { parseFlags } from '../src/diag/flags.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import { STROKE_BANDS } from '../src/render/strokes/bands.ts';
import { createStrokeBatch, DOME_DEPTH_WRITE } from '../src/render/strokes/batch.ts';
import {
  createFillArms,
  FILL_ARM_DEFINES,
  FILL_ARMS,
  FILL_DEFINES,
  FILL_MEDIUMP,
  FILL_NOSTREAM,
  FILL_PROGRAMS,
  FILL_SHADE3,
  type FillBatch,
  fillArms,
  moonNormalized,
  moonPacked,
} from '../src/render/strokes/fill-arms.ts';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial, type StrokeMaterial } from '../src/render/strokes/material.ts';
import fragmentShader from '../src/render/strokes/stroke.frag.glsl?raw';
import vertexShader from '../src/render/strokes/stroke.vert.glsl?raw';
import { mulberry32 } from '../src/util/prng.ts';

const tinyAtlas = (): DataTexture => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);

const fakeMaterial = (): StrokeMaterial =>
  ({ defines: {}, needsUpdate: false }) as unknown as StrokeMaterial;

function fakeBatch(): FillBatch & { domeWrite: boolean[] } {
  const domeWrite: boolean[] = [];
  return {
    materials: { near: fakeMaterial(), mid: fakeMaterial(), far: fakeMaterial() },
    geometries: () => [],
    setDomeDepthWrite: (on) => {
      domeWrite.push(on);
    },
    domeWrite,
  };
}

const fillDefines = (material: StrokeMaterial): string[] =>
  FILL_DEFINES.filter((name) => name in material.defines);

/**
 * The shader source with every `FILL_*` conditional resolved for `defined`; every other
 * directive passes through untouched.
 */
function resolveFill(source: string, defined: readonly string[]): string {
  const out: string[] = [];
  const stack: { fill: boolean; taking: boolean; parentTaking: boolean }[] = [];
  const taking = (): boolean => stack.every((s) => !s.fill || s.taking);
  for (const line of source.split('\n')) {
    const m = /^\s*#(ifdef|ifndef|else|endif)\s*(\S*)/.exec(line);
    if (m) {
      const [, directive, name] = m;
      if (directive === 'ifdef' || directive === 'ifndef') {
        const fill = name.startsWith('FILL_');
        const on = defined.includes(name) === (directive === 'ifdef');
        stack.push({ fill, taking: on, parentTaking: taking() });
        if (fill) continue;
      } else {
        const top = stack[stack.length - 1];
        if (directive === 'else') top.taking = !top.taking;
        else stack.pop();
        if (top.fill) continue;
      }
    }
    if (taking()) out.push(line);
  }
  return out.join('\n');
}

afterEach(() => {
  fillArms.set('base');
});

describe('createFillArms', () => {
  test('the arms and their programs', () => {
    expect(FILL_ARMS[0]).toBe('base');
    expect(FILL_ARM_DEFINES.base).toEqual([]);
    expect(FILL_ARM_DEFINES.domenowrite).toEqual([]);
    expect(FILL_ARM_DEFINES.lean).toEqual([FILL_NOSTREAM, FILL_SHADE3, FILL_MEDIUMP]);
    // base (shared with domenowrite), nostream, shade3, mediump and lean.
    expect(FILL_PROGRAMS.map((d) => d.join('+'))).toEqual([
      '',
      FILL_NOSTREAM,
      FILL_SHADE3,
      FILL_MEDIUMP,
      FILL_DEFINES.join('+'),
    ]);
  });

  test('inactive, it never touches a batch', () => {
    const arms = createFillArms();
    const batch = fakeBatch();
    arms.register(batch);
    expect(arms.active()).toBe(false);
    expect(arms.needsPrepare(batch)).toBe(false);
    expect(batch.domeWrite).toEqual([]);
    expect(fillDefines(batch.materials.near)).toEqual([]);
  });

  test('prepare compiles every program once and ends on base; then each arm sets its own lever', () => {
    const arms = createFillArms();
    const batch = fakeBatch();
    arms.register(batch);
    arms.activate();
    expect(arms.needsPrepare(batch)).toBe(true);
    // Before prepare, an arm with a program keeps base's, so no switch links one.
    arms.set('shade3');
    expect(fillDefines(batch.materials.near)).toEqual([]);

    const seen: string[][] = [];
    const geometry = new InstancedBufferGeometry();
    batch.geometries = () => [geometry];
    arms.prepare(batch, (object: Object3D) => {
      seen.push(
        fillDefines((object.children[0] as unknown as { material: StrokeMaterial }).material),
      );
      expect(object.children).toHaveLength(STROKE_BANDS.length);
    });
    expect(seen).toHaveLength(FILL_PROGRAMS.length);
    expect(seen.at(-1)).toEqual([]);
    expect(new Set(seen.map((d) => d.join('+'))).size).toBe(FILL_PROGRAMS.length);
    expect(arms.needsPrepare(batch)).toBe(false);
    // prepare re-applies the current arm.
    expect(fillDefines(batch.materials.far)).toEqual([FILL_SHADE3]);

    for (const arm of FILL_ARMS) {
      arms.set(arm);
      for (const band of STROKE_BANDS) {
        expect(fillDefines(batch.materials[band]), arm).toEqual([...FILL_ARM_DEFINES[arm]]);
      }
      expect(batch.domeWrite.at(-1), arm).toBe(arm !== 'domenowrite');
      expect(arms.diag()).toMatchObject({
        arm,
        defines: [...FILL_ARM_DEFINES[arm]],
        domeWrite: arm !== 'domenowrite',
        prepared: true,
      });
    }
    arms.set('base');
    expect(fillDefines(batch.materials.near)).toEqual([]);
    // A define is deleted, never left as `undefined`, which three would still emit.
    expect(Object.keys(batch.materials.near.defines)).toEqual([]);
  });
});

describe('the fill A/B group', () => {
  const flags = (ab: string) => ({ ...parseFlags(`?ab=${ab}`), calm: null });

  test('?ab=fill starts at base, and no flag implies it', () => {
    expect(resolveAb(flags('fill'))).toEqual({
      activation: { group: 'fill', start: 0 },
      warnings: [],
    });
    expect(resolveAb({ ...parseFlags('?wrap=wave'), calm: null }).activation?.group).toBe('wrap');
  });

  test('createAbGroup drives the shared arms', () => {
    const deps = {
      zdiag: { setMode: vi.fn(), prepare: vi.fn() },
      setHalo: vi.fn(),
      setCalm: vi.fn(),
      setWrap: vi.fn(),
    };
    const group = createAbGroup('fill', deps);
    expect(fillArms.active()).toBe(true);
    group.apply('domenowrite');
    expect(fillArms.arm()).toBe('domenowrite');
    group.apply('base');
    expect(fillArms.arm()).toBe('base');
    expect(deps.zdiag.prepare).not.toHaveBeenCalled();
  });
});

/** 40 dome strokes (DEPTH_BACKDROP_FLAG) and 40 ground strokes, far apart. */
function domeAndGround(): ReturnType<typeof createStrokeBuffers> {
  const rand = mulberry32(5);
  const buffers = createStrokeBuffers(80);
  for (let i = 0; i < buffers.count; i++) {
    const dome = i < 40;
    packInstance(buffers, i, {
      position: dome ? [rand() * 2, 100, -100 - rand() * 2] : [rand(), 0, -2 - rand()],
      normal: dome ? [0, -0.7071, 0.7071] : [0, 1, 0],
      tangent: 0,
      color: [40, 60, 200, 255],
      size: [0.2, 0.05],
      brush: i % 16,
      layer: dome ? STROKE_LAYER.sky : STROKE_LAYER.ground,
      phase: 0,
      flags: dome ? DEPTH_BACKDROP_FLAG : 0,
    });
  }
  return buffers;
}

describe('the stroke batch under the fill arms', () => {
  test('a default batch carries no FILL define and hooks the dome only; domenowrite unhooks it', () => {
    // fill-arms.ts's domeWriteFor assumes the dome writes depth by default.
    expect(DOME_DEPTH_WRITE).toBe(true);
    const batch = createStrokeBatch(domeAndGround(), { createAtlas: tinyAtlas });
    for (const band of STROKE_BANDS) expect(fillDefines(batch.materials[band])).toEqual([]);
    expect(fillDefines(createStrokeMaterial(tinyAtlas()))).toEqual([]);
    const dome = batch.chunks.filter((c) => c.drawClass === 'dome');
    const ground = batch.chunks.filter((c) => c.drawClass === 'world');
    expect(dome.length).toBeGreaterThan(0);
    expect(ground.length).toBeGreaterThan(0);
    const own = (c: (typeof dome)[number]): boolean => Object.hasOwn(c.mesh, 'onBeforeRender');
    expect(dome.every(own)).toBe(true);
    expect(ground.some(own)).toBe(false);
    const material = batch.materials.far;
    expect(material.depthWrite).toBe(false);
    const { mesh } = dome[0];
    const args = [null, null, null, mesh.geometry, material, null] as never[];
    (mesh.onBeforeRender as (...a: never[]) => void)(...args);
    expect(material.depthWrite).toBe(true);
    (mesh.onAfterRender as (...a: never[]) => void)(...args);
    expect(material.depthWrite).toBe(false);

    batch.setDomeDepthWrite(false);
    expect(batch.chunks.some(own)).toBe(false);
    batch.setDomeDepthWrite(true);
    expect(dome.every(own)).toBe(true);
    expect(ground.some(own)).toBe(false);
    batch.dispose();
  });
});

describe('the fill arms in the stroke shaders', () => {
  test('with no FILL define both shaders resolve to the shipped base path', () => {
    for (const source of [fragmentShader, vertexShader]) {
      const base = resolveFill(source, []);
      expect(base).not.toMatch(/FILL_|vMoon|mediump/);
    }
    const frag = resolveFill(fragmentShader, []);
    expect(frag).toContain(
      'vec3 n = normalize(vNormal - uRelief * (slope.x * vLong + slope.y * vShort));',
    );
    expect(frag).toContain('(vStream != 0.0 ? streamTone(t.b) : t.b)');
    expect(resolveFill(vertexShader, [])).toContain('vNormal = normalize(toWorld * n);');
  });

  test('each define swaps in only its own block', () => {
    const code = (source: string): string =>
      source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
    const nostream = code(resolveFill(fragmentShader, [FILL_NOSTREAM]));
    expect(nostream).not.toMatch(/vStream|streamTone/);
    expect(nostream).toContain('float tone = 0.75 + 0.5 * t.b;');
    const shade = code(resolveFill(fragmentShader, [FILL_SHADE3]));
    expect(shade).not.toMatch(/vNormal|vLong|vShort|normalize/);
    expect(shade).toContain('flat in vec3 vMoon;');
    const shadeVert = code(resolveFill(vertexShader, [FILL_SHADE3]));
    expect(shadeVert).not.toMatch(/vNormal|vLong|vShort/);
    expect(shadeVert).toContain('uniform vec3 uMoonDir;');
    const medium = resolveFill(fragmentShader, [FILL_MEDIUMP]);
    // After every declaration, so the uv, rect and uniforms stay highp.
    const at = medium.indexOf('precision mediump float;');
    expect(at).toBeGreaterThan(medium.indexOf('out vec4 fragColor;'));
    expect(at).toBeLessThan(medium.indexOf('float height('));
  });

  test('shade3 closed form matches the normalized relief normal over random frames', () => {
    const rand = mulberry32(11);
    const unit = (v: number[]): [number, number, number] => {
      const l = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const cross = (a: number[], b: number[]): [number, number, number] => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const n = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const t = unit(cross(n, unit([rand() - 0.5, rand() - 0.5, rand() - 0.5])));
      const s = cross(n, t);
      const m = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const slope: [number, number] = [(rand() - 0.5) * 60, (rand() - 0.5) * 60];
      const relief = 0.08;
      const a = moonNormalized(n, t, s, m, relief, slope);
      const b = moonPacked([dot(n, m), dot(t, m), dot(s, m)], relief, slope);
      worst = Math.max(worst, Math.abs(a - b));
    }
    expect(worst).toBeLessThan(1e-12);
  });
});
