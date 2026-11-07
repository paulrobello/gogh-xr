// Stroke motion (P4.1, PRD D7), spliced into stroke.vert.glsl at material build (material.ts). Every
// motion is a pure function of the uniforms and the instance's layer and phase: nothing is stored.
// The TypeScript mirror is src/motion/motion.ts (and sky-swirl.ts); change the two together.

// Motion time in seconds (src/motion/clock.ts): scaled by calm on the CPU, held while frozen,
// wrapped at MOTION_TIME_WRAP_S. Periods must divide the wrap (3600 / n), or they pop once an hour.
uniform float uTime;
// Calm, 0-1: every offset, turn and brightness is multiplied by it, once, in motionOffset (ruling
// R-P4e).
uniform float uCalm;
// The motion gate: bit L set when layer L's motion runs this frame, and REACTIVE_MOTION_BIT when
// the reactive motion runs on every layer (P4.5). 0 when frozen or at calm 0.
uniform uint uMotionLayers;
// The reactive motion's field (src/motion/reactive.ts): per disturber (head, controller 0,
// controller 1) its world position and strength (w, 0 when untracked) and its velocity, m/s; its
// wake samples, newest first, at j * WAKE_SAMPLES + i, with their weight in w; and the box round
// every weighted disturber and sample, grown by the radius (negative half extents when empty).
uniform vec4 uDisturbers[REACTIVE_DISTURBERS];
uniform vec4 uDisturberVelocities[REACTIVE_DISTURBERS];
uniform vec4 uWake[REACTIVE_WAKE_SAMPLES];
uniform vec3 uReactiveCentre;
uniform vec3 uReactiveHalf;

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

// The reactive gate (P4.5, ruling R-P4c): the reactive bit, then the stroke's rest centre p inside
// the reactive box. Outside the box the reactive motion is exactly 0, so a stroke there pays this
// AND, one subtract, abs and compare, and no reactive maths.
bool reactiveGate(vec3 p) {
  return (uMotionLayers & REACTIVE_MOTION_BIT) != 0u &&
    all(lessThan(abs(p - uReactiveCentre), uReactiveHalf));
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
// Matches cypressFlame in cypress-flame.ts. flame is the stroke's colour alpha, the byte the scatter
// bakes its lobe id (top three bits) and height level (low five) into; 255 is a stroke with none,
// which stays at rest. The stroke climbs s along up, its plane's steepest ascent (unnormalised,
// vertical part 1 - n.y^2), over a bounded arc that wraps with its phase and tapers to 0 at each
// apex, shrinking to nothing at the wrap. The lobe sways along side = Y x n, orthogonal to up and as
// long, by two travelling sines in y phased by the lobe id, by the height squared toward the tips. Two sines, two
// fracts and two smoothsteps per vertex.
Motion cypressMotion(vec3 p, vec3 n, float phase, float flame, float t) {
  uint b = uint(flame * 255.0 + 0.5);
  if (b == CYPRESS_FLAME_NONE) return Motion(vec3(0.0), 0.0, 0.0, 0.0);
  float h = float(b & 31u) * CYPRESS_INV_HEIGHT_LEVELS;
  float lobe = float(b >> 5u);
  float taper = smoothstep(0.0, CYPRESS_FLAME_TIP, 1.0 - h);
  float f = fract(t * CYPRESS_FLAME_INV_PERIOD + phase);
  float s = (2.0 * f - 1.0) * CYPRESS_FLAME_HALF_ARC * taper;
  float w = CYPRESS_FLICKER_W1 *
      sin(6.28318530718 * (p.y * CYPRESS_FLICKER_K1 - fract(t * CYPRESS_FLICKER_INV_P1) +
        lobe * CYPRESS_FLICKER_L1)) +
    CYPRESS_FLICKER_W2 *
      sin(6.28318530718 * (p.y * CYPRESS_FLICKER_K2 - fract(t * CYPRESS_FLICKER_INV_P2) +
        lobe * CYPRESS_FLICKER_L2));
  float a = CYPRESS_FLICKER_MAX * h * h * w;
  vec3 up = vec3(-n.x * n.y, 1.0 - n.y * n.y, -n.z * n.y);
  vec3 side = vec3(n.z, 0.0, -n.x);
  float gain = taper > 0.0 ? smoothstep(0.0, CYPRESS_FLAME_FADE, min(f, 1.0 - f)) - 1.0 : 0.0;
  return Motion(s * up + a * side, 0.0, gain, 0.0);
}
// Matches reactiveMotion in reactive.ts (P4.5), on every layer behind reactiveGate: each disturber
// pushes the stroke centred at p away by its strength times the falloff (1 - x²)² times
// PUSH_GAIN (p - d), 0 at the disturber itself, and drags it by its velocity times DRAG_S; each
// wake sample turns it about its normal n through the sample by weight times SWIRL times the
// falloff. The rotations' offsets are linear in p - w, so the loop sums t (p - w) and t and takes
// one cross product after it. The sum loses its part along n, so the stroke slides along its
// surface, and is clamped to REACTIVE_REACH; the turn is capped at REACTIVE_MAX_TURN. The gain is
// the push's areal stretch in the tangent plane, (1 + a)(1 + a - tr M) with a = calm G Σ s f² and
// tr M = calm 4 G / R² Σ s f |t|² (t the tangent part of p - d), as a size factor √J, never below
// 1 and capped at 1 + REACTIVE_MAX_GAIN: strokes spread apart grow to keep covering the surface
// (R-P4o). No phase: it is a pure function of p and the field.
// Cost per vertex inside the box, counted in scalar ALU operations (P4.6 holds to this count until
// it measures): 3 disturbers of about 25, 24 wake samples of about 15, then a tail of about 37
// (swirl cross product, normal removal, reach clamp, stretch), about 470 in all.
Motion reactiveMotion(vec3 p, vec3 n) {
  vec3 offset = vec3(0.0);
  float spread = 0.0;
  float squeeze = 0.0;
  for (int j = 0; j < REACTIVE_DISTURBERS; j++) {
    vec4 d = uDisturbers[j];
    vec3 e = p - d.xyz;
    float e2 = dot(e, e);
    float f = max(1.0 - e2 * REACTIVE_INV_RADIUS2, 0.0);
    float sf = d.w * f;
    float s = sf * f;
    offset += s * (REACTIVE_PUSH_GAIN * e + REACTIVE_DRAG_S * uDisturberVelocities[j].xyz);
    float en = dot(e, n);
    spread += s;
    squeeze += sf * (e2 - en * en);
  }
  vec3 swirl = vec3(0.0);
  float theta = 0.0;
  for (int i = 0; i < REACTIVE_WAKE_SAMPLES; i++) {
    vec4 w = uWake[i];
    vec3 e = p - w.xyz;
    float f = max(1.0 - dot(e, e) * REACTIVE_INV_RADIUS2, 0.0);
    float t = w.w * REACTIVE_SWIRL * f * f;
    swirl += t * e;
    theta += t;
  }
  offset += cross(n, swirl);
  offset -= n * dot(n, offset);
  offset *= min(1.0, REACTIVE_REACH * inversesqrt(max(dot(offset, offset), 1e-12)));
  float a = uCalm * REACTIVE_PUSH_GAIN * spread;
  float stretch = (1.0 + a) * (1.0 + a - uCalm * REACTIVE_STRETCH_M * squeeze);
  float gain = min(sqrt(max(stretch, 1.0)) - 1.0, REACTIVE_MAX_GAIN);
  return Motion(offset, min(theta, REACTIVE_MAX_TURN), gain, 0.0);
}

// Matches motionOffset in motion.ts. Only called behind the gate: layerMoves is the layer's own
// motionGate and reacts the reactiveGate, at least one true. The layer motion runs only behind its
// bit and the reactive motion only behind its gate. Their offsets, turns and brightnesses add; their
// gains combine as size factors, so a wrapping stroke still shrinks to nothing and a stretched one
// grows. MOTION_PHASE_PIN is the e2e's coherent phase
// (material.ts pinMotionPhase), never defined in a production build. flame is the instance's
// colour alpha, which only the cypress reads (P4.4).
Motion motionOffset(
  uint layer,
  vec3 p,
  vec3 n,
  uint phaseByte,
  float flame,
  bool layerMoves,
  bool reacts
) {
#ifdef MOTION_PHASE_PIN
  float phase = MOTION_PHASE_PIN;
#else
  float phase = float(phaseByte) * (1.0 / 256.0);
#endif
  float t = uTime;
  Motion m = Motion(vec3(0.0), 0.0, 0.0, 0.0);
  if (!layerMoves) {
  } else if (layer == STROKE_LAYER_SKY) {
    m = skyMotion(p, n, phase, t);
  } else if (layer == STROKE_LAYER_STAR) {
    m = starMotion(p, phaseByte, t);
  } else if (layer == STROKE_LAYER_MOON) {
    m = moonMotion(p, t);
  } else if (layer == STROKE_LAYER_CYPRESS) {
    m = cypressMotion(p, n, phase, flame, t);
  }
  if (reacts) {
    Motion r = reactiveMotion(p, n);
    m.offset += r.offset;
    m.turn += r.turn;
    m.gain = (1.0 + m.gain) * (1.0 + r.gain) - 1.0;
    m.bright += r.bright;
  }
  return scaleMotion(m, uCalm);
}

// Matches motionReach in motion.ts: how far, metres, the open gate can move the stroke centred at p
// from rest, calm included. Only called behind motionGate, for the haze's sky-light thin, so only
// the sky layer's reach is here: no star or moon stroke carries SKY_LIGHT_CULL_FLAG, and their
// rings stay inside the cones' rim (sky-rings.ts).
float motionReach(uint layer, vec3 p) {
  return layer == STROKE_LAYER_SKY ? uCalm * SKY_SWIRL_MAX_ANGLE * length(p - SKY_EYE) : 0.0;
}

// Matches reactiveReach in motion.ts: the farthest, metres, the reactive motion moves a stroke,
// calm included. Only called behind reactiveGate, for the haze's sky-light thin (R-P4b).
float reactiveReach() { return uCalm * REACTIVE_REACH; }
