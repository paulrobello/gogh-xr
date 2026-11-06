import { chromium } from '@playwright/test';
import { gpuArgs, gpuMode } from './gpu';

/** Logs the WebGL renderer the suite will run on, before any test starts. */
export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
  try {
    const page = await browser.newPage();
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no WebGL2 context';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'no debug renderer info';
    });
    console.log(`[e2e] PW_GPU=${gpuMode} UNMASKED_RENDERER_WEBGL: ${renderer}`);
  } finally {
    await browser.close();
  }
}
