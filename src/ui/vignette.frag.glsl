// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the material defines
// (CLEAR_RADIUS, FALLOFF, both radians).
precision highp float;

// Strength times the comfort factor, eased (vignette-alpha.ts).
uniform float uAlpha;
// The teleport blink (src/locomotion/teleport.ts): uniform black over the whole view.
uniform float uFade;
// The portal's veil (src/portal/switcher.ts): uniform uVeilColor over the whole view, display
// referred like the strokes drawn over it.
uniform float uVeil;
uniform vec3 uVeilColor;

in vec3 vView;

out vec4 fragColor;

void main() {
  // The angle off this eye's own forward axis (-z in its view space), so the ring is centred on
  // each eye's optical axis whatever the mesh's offset from it. It depends on direction only, so
  // both eyes see it at the same angle and it carries no stereo disparity.
  float angle = acos(clamp(-normalize(vView).z, -1.0, 1.0));
  float ring = smoothstep(CLEAR_RADIUS, CLEAR_RADIUS + FALLOFF, angle);
  float black = max(uAlpha * ring, uFade);
  // The veil over the black, composited as two layers.
  float alpha = 1.0 - (1.0 - black) * (1.0 - uVeil);
  vec3 color = alpha > 0.0 ? uVeilColor * (uVeil / alpha) : vec3(0.0);
  fragColor = vec4(color, alpha);
}
