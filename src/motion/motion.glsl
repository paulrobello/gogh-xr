// Stroke motion (P4.1, PRD D7), spliced into stroke.vert.glsl at material build (material.ts). Every
// motion is a pure function of the uniforms and the instance's layer and phase: nothing is stored.
// The TypeScript mirror is src/motion/motion.ts; change the two together.

// Motion time in seconds (src/motion/clock.ts): scaled by calm on the CPU, held while frozen,
// wrapped at MOTION_TIME_WRAP_S. Periods should divide the wrap, or they pop once an hour.
uniform float uTime;
// Calm, 0-1: every motion amplitude is multiplied by it, once, in motionOffset.
uniform float uCalm;
// The motion gate: bit L set when layer L's motion runs this frame. 0 when frozen or at calm 0.
uniform uint uMotionLayers;

// Matches motionGate in motion.ts. Layers are 0-5, so the shift stays inside the uint.
bool motionGate(uint layer) {
  return (uMotionLayers & (1u << layer)) != 0u;
}

// Per-layer displacement of the stroke centre p (model space), before calm scaling. phase is the
// instance's phase byte as a fraction in [0, 1), t is uTime. Stubs until their cards land.
vec3 skyMotion(vec3 p, float phase, float t) { return vec3(0.0); } // P4.2 swirl and wind
vec3 starMotion(vec3 p, float phase, float t) { return vec3(0.0); } // P4.3 halo rings
vec3 moonMotion(vec3 p, float phase, float t) { return vec3(0.0); } // P4.3 crescent halo
vec3 cypressMotion(vec3 p, float phase, float t) { return vec3(0.0); } // P4.4 flame
// Added for every layer (P4.5): the push away from the head and controllers, and their wake.
vec3 reactiveMotion(vec3 p, float phase, float t) { return vec3(0.0); }

// Matches motionOffset in motion.ts. Only called behind motionGate.
vec3 motionOffset(uint layer, vec3 p, uint phaseByte) {
  float phase = float(phaseByte) * (1.0 / 256.0);
  float t = uTime;
  vec3 offset = vec3(0.0);
  if (layer == STROKE_LAYER_SKY) {
    offset = skyMotion(p, phase, t);
  } else if (layer == STROKE_LAYER_STAR) {
    offset = starMotion(p, phase, t);
  } else if (layer == STROKE_LAYER_MOON) {
    offset = moonMotion(p, phase, t);
  } else if (layer == STROKE_LAYER_CYPRESS) {
    offset = cypressMotion(p, phase, t);
  }
  offset += reactiveMotion(p, phase, t);
  return uCalm * offset;
}
