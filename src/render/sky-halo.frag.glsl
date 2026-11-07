// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the halo defines.
precision highp float;
precision highp int;

in vec2 vLocal;
flat in vec3 vColor;
flat in float vPhase;
flat in float vInvWave;
flat in vec2 vBand;
flat in float vRest;
flat in float vRing;

out vec4 fragColor;

// #include sky-rings.glsl

// Matches skyHaloGlow in sky-rings.ts: a soft band, (1 - s²)² with s the radius's offset from the
// peak in half-widths, carrying the anchor's travelling rings. A star's band peaks at its centre.
// Blended additively (one, one), so it only adds light. One square root per fragment.
void main() {
  float rho = sqrt(dot(vLocal, vLocal));
  float s = (rho - vBand.x) / vBand.y;
  float fall = max(1.0 - s * s, 0.0);
  fall *= fall;
  float ring = ringBump(fract(vPhase - rho * vInvWave));
  fragColor = vec4(vColor * (fall * (vRest + vRing * ring)), 1.0);
}
