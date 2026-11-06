export type GpuMode = 'metal' | 'swiftshader';

// Parallel worktrees collide on the reserved port; override with E2E_PORT=NNNN make e2e.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4253);

export const gpuMode: GpuMode = process.env.PW_GPU === 'swiftshader' ? 'swiftshader' : 'metal';

export const gpuArgs: string[] =
  gpuMode === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|software/i.test(renderer);
}
