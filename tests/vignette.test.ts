import { BackSide, GLSL3, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CLEAR_RADIUS_DEG,
  createVignette,
  FALLOFF_DEG,
  VIGNETTE_RADIUS,
  VIGNETTE_RENDER_ORDER,
} from '../src/ui/vignette';

/** The camera's near plane in main.ts, which XR inherits as depthNear. */
const NEAR = 0.1;
/** The perf HUD's renderOrder (src/ui/perf-hud.ts). UI stays readable over the vignette. */
const HUD_RENDER_ORDER = 1_000_000;

describe('the vignette mesh', () => {
  it('is head-locked: a child of the camera, hidden at alpha 0 until it is needed', () => {
    const camera = new PerspectiveCamera();
    const vignette = createVignette(camera);
    expect(vignette.mesh.parent).toBe(camera);
    expect(vignette.mesh.visible).toBe(false);
    expect(vignette.mesh.material.uniforms.uAlpha.value).toBe(0);
  });

  it('shows above alpha 0 and hides at exactly 0, so rest costs no draw call', () => {
    const vignette = createVignette(new PerspectiveCamera());
    vignette.setAlpha(0.3);
    expect(vignette.mesh.visible).toBe(true);
    expect(vignette.mesh.material.uniforms.uAlpha.value).toBe(0.3);
    vignette.setAlpha(0);
    expect(vignette.mesh.visible).toBe(false);
    expect(vignette.mesh.material.uniforms.uAlpha.value).toBe(0);
  });

  it('the teleport fade shows it whatever the tunnel alpha, and hides only once both are 0', () => {
    const vignette = createVignette(new PerspectiveCamera());
    const { uniforms } = vignette.mesh.material;
    expect(uniforms.uFade.value).toBe(0);
    vignette.setFade(1);
    expect(uniforms.uFade.value).toBe(1);
    expect(vignette.mesh.visible).toBe(true);
    // The tunnel at rest sets alpha 0 every frame: the fade must survive it.
    vignette.setAlpha(0);
    expect(vignette.mesh.visible).toBe(true);
    vignette.setAlpha(0.4);
    vignette.setFade(0);
    expect(vignette.mesh.visible).toBe(true);
    vignette.setAlpha(0);
    expect(vignette.mesh.visible).toBe(false);
    expect(uniforms.uAlpha.value).toBe(0);
  });

  it('draws the fade as full-view black over the ring, not inside it', () => {
    const { material } = createVignette(new PerspectiveCamera()).mesh;
    // The ring is 0 at the centre, so the fade cannot be a factor of it.
    expect(material.fragmentShader).toMatch(/max\(\s*uAlpha \* ring,\s*uFade\s*\)/);
  });

  it('is a transparent GLSL3 overlay with no depth test or write, ordered under the HUD', () => {
    const { mesh } = createVignette(new PerspectiveCamera());
    const material = mesh.material;
    expect(material.glslVersion).toBe(GLSL3);
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(BackSide);
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.renderOrder).toBe(VIGNETTE_RENDER_ORDER);
    expect(VIGNETTE_RENDER_ORDER).toBeLessThan(HUD_RENDER_ORDER);
  });

  it('carries the clear radius and falloff into the shader, in radians', () => {
    const { mesh } = createVignette(new PerspectiveCamera());
    const defines = mesh.material.defines as Record<string, string>;
    expect(Number(defines.CLEAR_RADIUS)).toBeCloseTo((CLEAR_RADIUS_DEG * Math.PI) / 180, 7);
    expect(Number(defines.FALLOFF)).toBeCloseTo((FALLOFF_DEG * Math.PI) / 180, 7);
    expect(defines.CLEAR_RADIUS).toMatch(/[.e]/);
  });

  it('sits beyond the near plane across each eye of a Quest 3, from three’s union camera', () => {
    const { mesh } = createVignette(new PerspectiveCamera());
    expect(VIGNETTE_RADIUS).toBeGreaterThanOrEqual(0.15);
    // three's XR camera sits a few cm behind the eyes; each eye is half the IPD to the side.
    // Depth is linear over a flat facet, so a facet's nearest point is one of its vertices.
    const positions = mesh.geometry.getAttribute('position');
    const v = new Vector3();
    let checked = 0;
    for (const eyeX of [-0.0315, 0.0315]) {
      const eye = new Vector3(eyeX, 0, -0.04);
      for (let i = 0; i < positions.count; i += 1) {
        v.fromBufferAttribute(positions, i).sub(eye);
        // 70° off the eye's forward axis: past a Quest 3 frustum corner (about 60°).
        if (-v.z < v.length() * Math.cos((70 * Math.PI) / 180)) continue;
        expect(-v.z).toBeGreaterThan(NEAR);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('dispose detaches it from the camera', () => {
    const camera = new PerspectiveCamera();
    const vignette = createVignette(camera);
    vignette.dispose();
    expect(vignette.mesh.parent).toBeNull();
    expect(camera.children).toHaveLength(0);
  });
});
