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
// The sky's stream wrap (stroke.vert.glsl): sign × (1 + brush + f), 0 for no stream.
flat in float vStream;
// Per brush, twice its tone's correlation half a stream shift along u (SKY_STREAM_RHOS).
const float SKY_STREAM_RHO2S[BRUSH_COUNT] = SKY_STREAM_RHO2;

out vec4 fragColor;

// Height with the coverage premultiply undone (atlas quirk C8), guarded against empty texels.
float height(vec4 texel) {
  return texel.g / max(texel.r, 0.05);
}

// Matches skyStreamWeights and skyStreamTone in sky-swirl.ts: the stream wrap's tone at this
// fragment from the rest tap's tone. Two layer taps slide along u, the stroke's length, by
// (f - 1/2) SKY_STREAM_SHIFT of the brush rect each, half a loop apart, clamped to the rect like
// the relief taps; a tap that leaves the shape falls back to the rest tone by its coverage. Their
// weights sum to 1 and each is 0 where its layer resets, and the deviation from the tone's mean
// scales by 1 / sqrt(wA² + wB² + 2 rho wA wB), rho the brush's, so the blend keeps one layer's
// contrast. The gain fades to 1 as either tap leaves the shape, since a tap that fell back to the
// rest tone is fully correlated with it. The offset is constant over the primitive and vStream is
// flat, so the implicit-derivative taps run in uniform control flow and pick the rest tap's mip.
// vStream decodes to the brush (its whole part less 1), f (its fraction) and the sign; f rounding
// up to the next whole number at the loop's end reads the next brush's rho for that frame, where
// wA is 0 and the gain is 1 for any rho. Two taps and about 25 ALU operations.
float streamTone(float rest) {
  float packed = abs(vStream) - 1.0;
  float fA = fract(packed);
  float fB = fract(fA + 0.5);
  float wA = 1.0 - abs(2.0 * fA - 1.0);
  float wB = 1.0 - wA;
  float span = (vRect.z - vRect.x) * SKY_STREAM_SHIFT * sign(vStream);
  vec4 a = texture(uAtlas, clamp(vUv - vec2((fA - 0.5) * span, 0.0), vRect.xy, vRect.zw));
  vec4 b = texture(uAtlas, clamp(vUv - vec2((fB - 0.5) * span, 0.0), vRect.xy, vRect.zw));
  float ta = mix(rest, a.b, a.r);
  float tb = mix(rest, b.b, b.r);
  float rho2 = SKY_STREAM_RHO2S[min(int(packed), BRUSH_COUNT - 1)];
  float gain = mix(1.0, inversesqrt(wA * wA + wB * wB + rho2 * wA * wB), a.r * b.r);
  float m = SKY_STREAM_TONE_MEAN;
  return clamp(m + (wA * (ta - m) + wB * (tb - m)) * gain, 0.0, 1.0);
}

void main() {
  vec4 t = texture(uAtlas, vUv);
  // The coverage mip cap (COVERAGE_MAX_LOD in material.ts): the GPU picks the mip from the larger
  // screen derivative, so past the cap the tap is retaken there. Below it the implicit tap stands.
  vec2 du = dFdx(vUv) * float(ATLAS_SIZE);
  vec2 dv = dFdy(vUv) * float(ATLAS_SIZE);
  if (max(dot(du, du), dot(dv, dv)) > COVERAGE_MAX_RHO2) {
    t = textureLod(uAtlas, vUv, COVERAGE_MAX_LOD);
  }
  float cov = t.r;
  // Ruling R3: sharpen coverage to ~0 or 1 except a one-pixel rim, so alpha-to-coverage does not
  // dither the stroke interior into flickering stripes.
#ifdef ZDIAG_SHARP_GAIN
  // `?zdiag=sharp` and `sharp4` (src/render/zdiag.ts): the R3 gain times 2 or 4, so the rim is a
  // half or a quarter of a pixel wide.
  float alpha =
    clamp((cov - 0.5) / max(fwidth(cov), 1e-4) * float(ZDIAG_SHARP_GAIN) + 0.5, 0.0, 1.0);
#else
  float alpha = clamp((cov - 0.5) / max(fwidth(cov), 1e-4) + 0.5, 0.0, 1.0);
#endif
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
  // The stream wrap's tone (streamTone); every other fragment pays this one compare.
  float tone = 0.75 + 0.5 * (vStream != 0.0 ? streamTone(t.b) : t.b);
  fragColor = vec4(vColor * tone * shade, alpha);
}
