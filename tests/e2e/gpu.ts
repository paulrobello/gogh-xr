export type GpuMode = 'metal' | 'swiftshader';

export { E2E_PORT } from '../../scripts/ports';

export const gpuMode: GpuMode = process.env.PW_GPU === 'swiftshader' ? 'swiftshader' : 'metal';

export const gpuArgs: string[] =
  gpuMode === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|software/i.test(renderer);
}
