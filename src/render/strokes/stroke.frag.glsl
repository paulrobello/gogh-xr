// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the material defines
// (ATLAS_SIZE, RECT_TEXELS, RELIEF_MIN_TEXELS).
precision highp float;
precision highp int;

// R coverage, G height (premultiplied by coverage), B tone (0.5 neutral). See brush-atlas-data.ts.
uniform sampler2D uAtlas;
// Unit vector towards the moon, in world space.
uniform vec3 uMoonDir;
// Normal tilt per unit of height change over one stroke length.
uniform float uRelief;

in vec2 vUv;
flat in vec3 vColor;
flat in vec4 vRect;
flat in vec3 vNormal;
flat in vec3 vLong;
flat in vec3 vShort;

out vec4 fragColor;

// Height with the coverage premultiply undone (atlas quirk C8), guarded against empty texels.
float height(vec4 texel) {
  return texel.g / max(texel.r, 0.05);
}

void main() {
  vec4 t = texture(uAtlas, vUv);
  float cov = t.r;
  // Ruling R3: sharpen coverage to ~0 or 1 except a one-pixel rim, so alpha-to-coverage does not
  // dither the stroke interior into flickering stripes.
  float alpha = clamp((cov - 0.5) / max(fwidth(cov), 1e-4) + 0.5, 0.0, 1.0);
#ifdef ZDIAG_ALPHA_TEST
  // `?zdiag=noa2c` (src/render/zdiag.ts): alpha-to-coverage is off, so cut the shape out instead.
  if (alpha < 0.5) discard;
#endif

  // Forward differences along the stroke frame (atlas u runs along the stroke, v across it). The
  // step follows the pixel footprint, so a distant stroke compares mip texels a pixel apart and
  // keeps its broad relief instead of differencing two nearly equal blurred samples.
  vec2 footprint = fwidth(vUv) * float(ATLAS_SIZE);
  float stepTexels = max(float(RELIEF_MIN_TEXELS), max(footprint.x, footprint.y));
  float stepUv = stepTexels / float(ATLAS_SIZE);
  // Clamped to the brush's own rect: a distant footprint can exceed the atlas gutter.
  vec4 tu = texture(uAtlas, clamp(vUv + vec2(stepUv, 0.0), vRect.xy, vRect.zw));
  vec4 tv = texture(uAtlas, clamp(vUv + vec2(0.0, stepUv), vRect.xy, vRect.zw));
  float h = height(t);
  // Fade the relief where any tap nears the rim, so the coverage falloff never reads as an outline.
  float rim = smoothstep(0.5, 0.9, min(cov, min(tu.r, tv.r)));
  vec2 slope = vec2(height(tu) - h, height(tv) - h) * (float(RECT_TEXELS) / stepTexels) * rim;
  vec3 n = normalize(vNormal - uRelief * (slope.x * vLong + slope.y * vShort));

  // Half-Lambert moonlight kept to a ±15% band so the painted colour dominates.
  float moon = dot(n, uMoonDir) * 0.5 + 0.5;
  float shade = 0.85 + 0.3 * moon;
  float tone = 0.75 + 0.5 * t.b;
  fragColor = vec4(vColor * tone * shade, alpha);
}
