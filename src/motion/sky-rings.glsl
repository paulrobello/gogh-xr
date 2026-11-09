// Star and moon rings (P4.3, src/motion/sky-rings.ts), spliced into stroke.vert.glsl and both
// halo shaders (src/render/sky-halo.ts) at their `// #include sky-rings.glsl` line, so the strokes
// and the halo read one wave. The tables come from skyRingGlslDefines; change them together.

// Per anchor (11 stars, then the moon at SKY_RING_MOON): xyz the dome centre, w 1 / period.
const vec4 SKY_RING_CENTRE[SKY_RING_COUNT] = SKY_RING_CENTRES;
// x the phase at t = 0, y 1 / wavelength (metres), z the still inner radius, w the rim reach.
const vec4 SKY_RING_WAVE[SKY_RING_COUNT] = SKY_RING_WAVES;
// x swell / (outer - inner), y brightness at a crest from the inner radius out, z inside it.
const vec3 SKY_RING_GAIN[SKY_RING_COUNT] = SKY_RING_GAINS;

// Matches ringBump in sky-rings.ts: (4f(1 - f))², 0 at the wrap and flat across it, 1 at f = 0.5.
float ringBump(float f) {
  float b = 4.0 * f * (1.0 - f);
  return b * b;
}
