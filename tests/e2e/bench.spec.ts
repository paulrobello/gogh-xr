import { type Diag, expect, test, type Xr } from './fixtures';

interface BenchDiag {
  n: number;
  mode: string;
  order: string;
  chunks: number;
  instances: number;
  fps: number;
  viewport: { width: number; height: number } | null;
}

interface RendererDiag {
  geometries: number;
  programs: number;
}

async function bench(xr: Xr): Promise<BenchDiag> {
  // The bench registers its diag key after an async chunk import.
  await expect.poll(async () => (await xr.diag()).bench !== undefined).toBe(true);
  return (await xr.diag()).bench as BenchDiag;
}

function memory(diag: Diag): RendererDiag {
  const { geometries, programs } = diag.renderer as unknown as RendererDiag;
  return { geometries, programs };
}

test('bench fills 100k strokes and left-stick N steps release GPU resources', async ({ xr }) => {
  await xr.boot('bench=100000');
  await xr.enterXR();

  expect(await bench(xr)).toMatchObject({
    n: 100000,
    mode: 'a2c',
    order: 'random',
    instances: 100000,
    chunks: 2,
  });
  await expect.poll(async () => (await bench(xr)).fps).toBeGreaterThan(0);
  const viewport = (await bench(xr)).viewport;
  expect(viewport?.width).toBeGreaterThan(0);
  expect(viewport?.height).toBeGreaterThan(0);

  await xr.waitFrames(5);
  const baseline = memory(await xr.diag());

  await xr.stick('left', 1, 0);
  await expect.poll(async () => (await bench(xr)).instances).toBe(125000);
  await xr.stick('left', 0, 0);
  expect(await bench(xr)).toMatchObject({ n: 125000, chunks: 2 });

  await xr.stick('left', -1, 0);
  await expect.poll(async () => (await bench(xr)).instances).toBe(100000);
  await xr.stick('left', 0, 0);
  expect(await bench(xr)).toMatchObject({ n: 100000, chunks: 2 });

  await xr.waitFrames(5);
  expect(memory(await xr.diag())).toEqual(baseline);
});

test('blend mode renders sorted strokes without WebGL errors', async ({ xr }) => {
  await xr.boot('bench=70000&mode=blend');
  await xr.enterXR();
  expect(await bench(xr)).toMatchObject({
    n: 70000,
    mode: 'blend',
    order: 'sorted',
    instances: 70000,
    chunks: 2,
  });
  await expect.poll(async () => (await bench(xr)).fps).toBeGreaterThan(0);
});
