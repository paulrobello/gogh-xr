// Stroke motion (P4.1, PRD D7), spliced into stroke.vert.glsl at material build (material.ts). Every
// motion is a pure function of the uniforms and the instance's layer and phase: nothing is stored.
// The TypeScript mirror is src/motion/motion.ts (and sky-swirl.ts); change the two together.

// Motion time in seconds (src/motion/clock.ts): scaled by calm on the CPU, held while frozen,
// wrapped at MOTION_TIME_WRAP_S. Periods must divide the wrap (3600 / n), or they pop once an hour.
uniform float uTime;
// Calm, 0-1: every offset, turn and brightness is multiplied by it, once, in motionOffset (ruling
// R-P4e).
uniform float uCalm;
// The motion gate: bit L set when layer L's motion runs this frame. 0 when frozen or at calm 0.
uniform uint uMotionLayers;

// One stroke's motion, every field 0 at rest. offset moves the stroke centre (model space), turn
// rotates it about its normal from the long axis towards the short axis (radians, small:
// stroke.vert.glsl takes its cosine and sine as polynomials), the stroke draws at 1 + gain of its
// size and at 1 + bright of its colour. Calm scales offset, turn and bright, the amplitudes: gain is
// a loop's wrap envelope, which shrinks a stroke to nothing as it jumps back at every calm, so it
// runs at full depth whenever the gate is open (amended R-P4e).
struct Motion {
  vec3 offset;
  float turn;
  float gain;
  float bright;
};

// Matches motionGate in motion.ts. Layers are 0-5, so the shift stays inside the uint.
bool motionGate(uint layer) {
  return (uMotionLayers & (1u << layer)) != 0u;
}

// Scales the offset, turn and brightness by k and keeps the gain (the wrap envelope) at full depth.
Motion scaleMotion(Motion m, float k) {
  return Motion(k * m.offset, k * m.turn, m.gain, k * m.bright);
}

// The sky vortices (src/motion/sky-swirl.ts): xyz the unit direction from SKY_EYE through the
// centre, w half its circulation; and half the squared chord of each core radius.
const vec4 SKY_VORTEX_AXIS[SKY_VORTEX_COUNT] = SKY_VORTEX_AXES;
const float SKY_VORTEX_CORE[SKY_VORTEX_COUNT] = SKY_VORTEX_CORES;

// Matches skySwirl in sky-swirl.ts. The field is one rotation vector about SKY_EYE: each vortex
// turns at gamma / max(chord², core²) about its axis (Rankine, no square root), plus the drift about
// the vertical. The stroke sweeps a short arc of it per SKY_SWIRL_PERIOD and wraps, shrinking to
// nothing at the wrap. SKY_VORTEX_COUNT is a handful (4): each vortex costs a dot, a max, a divide
// and a multiply-add per vertex.
Motion skyMotion(vec3 p, vec3 n, float phase, float t) {
  vec3 d = p - SKY_EYE;
  vec3 dir = d * inversesqrt(dot(d, d));
  vec3 omega = vec3(0.0, SKY_DRIFT, 0.0);
  for (int i = 0; i < SKY_VORTEX_COUNT; i++) {
    vec4 v = SKY_VORTEX_AXIS[i];
    omega += v.xyz * (v.w / max(1.0 - dot(v.xyz, dir), SKY_VORTEX_CORE[i]));
  }
  float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
  float tau = (f - 0.5) * SKY_SWIRL_PERIOD;
  return Motion(
    tau * cross(omega, d),
    tau * dot(omega, n),
    smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f)) - 1.0,
    0.0
  );
}

// Matches skyRing in sky-rings.ts. The stroke centred at p rings round anchor k (sky-rings.glsl):
// a crest slides it radially out by the swell times its hat, 0 inside the still inner radius and at
// the rim, so no moved centre passes the rim, and from the inner radius out brightens it by
// SKY_RING_GAIN.y, so the moon's crescent stays as painted. One inverse square root; the distance is
// clamped so the direction never divides by 0.
Motion ringMotion(int k, vec3 p, float t) {
  vec4 c = SKY_RING_CENTRE[k];
  vec4 wave = SKY_RING_WAVE[k];
  vec2 gain = SKY_RING_GAIN[k];
  vec3 d = p - c.xyz;
  float d2 = max(dot(d, d), 1e-6);
  float inv = inversesqrt(d2);
  float r = d2 * inv;
  float w = ringBump(fract(t * c.w + wave.x - r * wave.y));
  float hat = max(r - wave.z, 0.0) * max(wave.w - r, 0.0);
  return Motion((gain.x * w * hat * inv) * d, 0.0, 0.0, gain.y * w * step(wave.z, r));
}

// Per-layer motion of the stroke centred at p with unit normal n, before calm scaling. phase is the
// instance's phase byte as a fraction in [0, 1), t is uTime. The stars and the moon ring by anchor
// (P4.3): a star stroke's phase byte names its star (src/world/sky-lights.ts), clamped so a stray
// byte stays in the table, and every moon stroke rings round the moon. Their rings' phase is per
// anchor, so neither reads the stroke phase, and MOTION_PHASE_PIN leaves them as they are.
Motion starMotion(vec3 p, uint phaseByte, float t) {
  return ringMotion(int(min(phaseByte, uint(SKY_RING_STAR_COUNT - 1))), p, t);
}
Motion moonMotion(vec3 p, float t) { return ringMotion(SKY_RING_MOON, p, t); }
Motion cypressMotion(vec3 p, vec3 n, float phase, float t) { return Motion(vec3(0.0), 0.0, 0.0, 0.0); } // P4.4 flame
// Added for every layer (P4.5): the push away from the head and controllers, and their wake.
Motion reactiveMotion(vec3 p, vec3 n, float phase, float t) { return Motion(vec3(0.0), 0.0, 0.0, 0.0); }

// Matches motionOffset in motion.ts. Only called behind motionGate. MOTION_PHASE_PIN is the e2e's
// coherent phase (material.ts pinMotionPhase), never defined in a production build.
Motion motionOffset(uint layer, vec3 p, vec3 n, uint phaseByte) {
#ifdef MOTION_PHASE_PIN
  float phase = MOTION_PHASE_PIN;
#else
  float phase = float(phaseByte) * (1.0 / 256.0);
#endif
  float t = uTime;
  Motion m = Motion(vec3(0.0), 0.0, 0.0, 0.0);
  if (layer == STROKE_LAYER_SKY) {
    m = skyMotion(p, n, phase, t);
  } else if (layer == STROKE_LAYER_STAR) {
    m = starMotion(p, phaseByte, t);
  } else if (layer == STROKE_LAYER_MOON) {
    m = moonMotion(p, t);
  } else if (layer == STROKE_LAYER_CYPRESS) {
    m = cypressMotion(p, n, phase, t);
  }
  Motion r = reactiveMotion(p, n, phase, t);
  m.offset += r.offset;
  m.turn += r.turn;
  m.gain += r.gain;
  m.bright += r.bright;
  return scaleMotion(m, uCalm);
}

// Matches motionReach in motion.ts: how far, metres, the open gate can move the stroke centred at p
// from rest, calm included. Only called behind motionGate, for the haze's sky-light thin, so only
// the sky layer's reach is here: no star or moon stroke carries SKY_LIGHT_CULL_FLAG, and their
// rings stay inside the cones' rim (sky-rings.ts).
float motionReach(uint layer, vec3 p) {
  return layer == STROKE_LAYER_SKY ? uCalm * SKY_SWIRL_MAX_ANGLE * length(p - SKY_EYE) : 0.0;
}
