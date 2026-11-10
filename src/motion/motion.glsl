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
// controller 1) its world position and strength (w, 0 when untracked) and its rig-relative velocity, m/s; its
// wake samples, newest first, at j * WAKE_SAMPLES + i, with their weight in w; and the box round
// every weighted disturber and sample, each grown by its disturber's radius (negative half extents
// when empty).
uniform vec4 uDisturbers[REACTIVE_DISTURBERS];
uniform vec4 uDisturberVelocities[REACTIVE_DISTURBERS];
uniform vec4 uWake[REACTIVE_WAKE_SAMPLES];
uniform vec3 uReactiveCentre;
uniform vec3 uReactiveHalf;
// The sky wrap A/B variant (src/motion/variants.ts): SKY_WRAP_WAVE (0), SKY_WRAP_WHEEL,
// SKY_WRAP_STREAM, SKY_WRAP_BASE, SKY_WRAP_PINGPONG, SKY_WRAP_WHEELFLOW (the default) or
// SKY_WRAP_WHEELRUN. Read in skyMotion, so a moving sky vertex under wave pays one compare, base
// two, pingpong three, wheel four, stream five, and wheelflow and wheelrun six, and on haze
// vertices up to four times in skyHazeWheel and, off wheel, once in motionReach.
uniform uint uSkyWrap;
// The wave's waves per turn (SKY_WAVE_TURNS in sky-swirl.ts, ?waveturns), read by skyWavePhase
// on the wave branch and on the default wheelflow's branch outside the wheels.
uniform int uWaveTurns;

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

vec2 skyCmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// Matches skyWavePhase in sky-swirl.ts up to whole loops: the wave's loop phase at unit direction
// dir, at uWaveTurns waves per turn, the arg of the product of each pole's unit offset in the
// stereographic plane raised to its winding (skyWaveProductPhase). SKY_WAVE_PRODUCT is those
// statements, unrolled from the poles, declaring q, the part of the product fixed across the turns,
// and a, the part per turn, which the loop raises to uWaveTurns. The divide is clamped at the nadir,
// where no sky stroke shows. One atan.
float skyWavePhase(vec3 dir) {
  vec2 z = dir.xz / max(1.0 + dir.y, 1e-6);
  SKY_WAVE_PRODUCT
  for (int i = 0; i < SKY_WAVE_MAX_TURNS; i++) {
    if (i >= uWaveTurns) break;
    q = skyCmul(q, a);
  }
  return atan(q.y, q.x) * SKY_WAVE_INV_TAU;
}

// The poles skyWaveFade stills (skyWaveFadePoles in sky-swirl.ts): unit directions from SKY_EYE.
const vec3 SKY_WAVE_FADE_POLE[SKY_WAVE_FADE_COUNT] = SKY_WAVE_FADE_POLES;

// Matches skyWaveFade in sky-swirl.ts: wave's amplitude, 0 at each pole and 1 from
// SKY_WAVE_FADE_RADIUS out, a smoothstep over the squared chord.
float skyWaveFade(vec3 dir) {
  float fade = 1.0;
  for (int i = 0; i < SKY_WAVE_FADE_COUNT; i++) {
    vec3 e = dir - SKY_WAVE_FADE_POLE[i];
    fade *= smoothstep(0.0, SKY_WAVE_FADE_CHORD2, dot(e, e));
  }
  return fade;
}

// Matches the wave and pingpong wraps of skySwirl in sky-swirl.ts (src/motion/variants.ts), at loop
// phase `phase` and tau amplitude `amplitude`. Neither changes the stroke's size. pingpong sweeps
// base's arc forward over half the loop and eases back over the other half, so it never jumps and
// |tau| stays within half a period. wave runs the same loop at a phase set by the stroke's
// direction (skyWavePhase), plus a small jitter from its phase byte, its amplitude scaled by
// skyWaveFade.
Motion skyWrapMotion(vec3 d, vec3 omega, vec3 n, float phase, float amplitude, float t) {
  float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
  float tau = (smoothstep(0.0, 1.0, 1.0 - abs(2.0 * f - 1.0)) - 0.5) * amplitude;
  return Motion(tau * cross(omega, d), tau * dot(omega, n), 0.0, 0.0);
}

// The wheel wrap's discs (skyWheels in sky-swirl.ts), in vortex order: half the squared chord of
// each wheel's radius, its signed turns per second, a whole number per MOTION_TIME_WRAP_S, and
// the angles from its axis of its members' rim (edge) and of 0.95 of its core (cap), radians, which
// only the haze's thin reads (skyHazeWheel).
const float SKY_WHEEL_CORE[SKY_VORTEX_COUNT] = SKY_WHEEL_CORES;
const float SKY_WHEEL_RATE[SKY_VORTEX_COUNT] = SKY_WHEEL_RATES;
const float SKY_WHEEL_EDGE[SKY_VORTEX_COUNT] = SKY_WHEEL_EDGES;
const float SKY_WHEEL_CAP[SKY_VORTEX_COUNT] = SKY_WHEEL_CAPS;

// v turned by the unit quaternion (q, w): v + 2w (q × v) + 2 q × (q × v).
vec3 skyQuatRotate(vec3 q, float w, vec3 v) {
  vec3 u = 2.0 * cross(q, v);
  return v + w * u + cross(q, u);
}

// Matches skyWheelSpin and skySwirl's wheel branch in sky-swirl.ts: a stroke at d from SKY_EYE,
// unit direction dir, inside wheel i (1 - c·dir under half its squared chord) turns rigidly about
// the wheel's axis c by 2π fract(t rate), unbounded in time and periodic, as the unit quaternion
// of half that angle, with the built-in sine and cosine. Its centre, its normal n and both axes l
// and s turn with it, so the stroke keeps its place in the disc, with no shear and no reset. The
// boundary haze (SKY_LIGHT_CULL_FLAG) in front of a wheel, chosen by the same direction from the
// eye, turns with it, and every stroke outside the wheels holds still. The turn's
// offset goes to rigid, which motionOffset adds after its calm scaling: a turned disc scaled by calm
// would fold onto its axis, so the wheel keeps its radius at every calm and calm slows it through
// uTime instead. At calm 0 uTime stops and the clock keeps the sky gate open under wheel
// (clock.ts setHoldMask), so the discs hold their pose rather than snapping to rest. The wheels are
// disjoint, so at most one matches. Per vertex in a wheel: a fract, a sine, a cosine and four
// quaternion turns.
Motion skyWheelMotion(
  vec3 d,
  vec3 dir,
  inout vec3 n,
  inout vec3 l,
  inout vec3 s,
  float t,
  inout vec3 rigid
) {
  for (int i = 0; i < SKY_VORTEX_COUNT; i++) {
    vec3 c = SKY_VORTEX_AXIS[i].xyz;
    if (1.0 - dot(c, dir) >= SKY_WHEEL_CORE[i]) continue;
    float h = SKY_HALF_TURN * fract(t * SKY_WHEEL_RATE[i]);
    vec3 q = sin(h) * c;
    float w = cos(h);
    n = skyQuatRotate(q, w, n);
    l = skyQuatRotate(q, w, l);
    s = skyQuatRotate(q, w, s);
    rigid = skyQuatRotate(q, w, d) - d;
    break;
  }
  return Motion(vec3(0.0), 0.0, 0.0, 0.0);
}

// The boundary haze under wheel (stroke.vert.glsl, behind the open sky gate): the haze is the one
// sky stroke with SKY_LIGHT_CULL_FLAG, and no other layer carries it. Returns false under every
// other wrap, at one compare, and the caller widens the thin by motionReach instead. Under wheel it
// turns a haze stroke centred at p in a wheel with it (skyWheelMotion: n, l, s and rigid, which the
// caller adds and hands no other sky motion), so motionOffset runs no second wheel loop, and
// returns true with `thin` the wheel's thin of a stroke of angular half extent halfExtent / |d|
// (the half diagonal over its distance, at least its true angle). The haze is 2.5-3.1° long, about
// twice a dome stroke, so membership by the dome's margin lets it reach past the 0.95 cap: a turned
// haze stroke whose extent crosses another wheel's cap (SKY_WHEEL_CAP, the 0.95 core) would slide
// against that wheel at the contact (the tear), and a still one whose extent crosses a wheel's edge
// (SKY_WHEEL_EDGE, the members' rim) would veil the turning disc. Each thins to 0 there, ramping
// back over SKY_WHEEL_HAZE_FEATHER of clear gap, judged at the full size like skyLightThin, so a
// drawn quad never crosses. The dome behind is covered, so a thinned haze stroke leaves no bare sky.
// Its own wheel is skipped: a turn about its axis keeps the stroke's angle to it.
// Under wheelflow and wheelrun it does the same, but returns true only for a haze stroke in a
// wheel: one outside the wheels travels like the dome behind it (skyMotion), its thin judged here
// at rest against the members' edges, and skyWheelFlowTravel then fades its travel by its own
// clearance from those edges, widened by its half diagonal (flowExtent), so its moved quad stays
// clear of every turning disc too.
bool skyHazeWheel(
  vec3 p,
  float halfExtent,
  inout vec3 n,
  inout vec3 l,
  inout vec3 s,
  inout vec3 rigid,
  inout float thin
) {
  if (uSkyWrap != SKY_WRAP_WHEEL && uSkyWrap != SKY_WRAP_WHEELFLOW && uSkyWrap != SKY_WRAP_WHEELRUN) {
    return false;
  }
  vec3 d = p - SKY_EYE;
  float inv = inversesqrt(dot(d, d));
  vec3 dir = d * inv;
  int member = -1;
  for (int i = 0; i < SKY_VORTEX_COUNT; i++) {
    if (1.0 - dot(SKY_VORTEX_AXIS[i].xyz, dir) < SKY_WHEEL_CORE[i]) member = i;
  }
  skyWheelMotion(d, dir, n, l, s, uTime, rigid);
  vec3 seen = normalize(d + rigid);
  float h = halfExtent * inv;
  for (int j = 0; j < SKY_VORTEX_COUNT; j++) {
    if (j == member) continue;
    float edge = member < 0 ? SKY_WHEEL_EDGE[j] : SKY_WHEEL_CAP[j];
    float theta = acos(clamp(dot(SKY_VORTEX_AXIS[j].xyz, seen), -1.0, 1.0));
    thin *= smoothstep(0.0, SKY_WHEEL_HAZE_FEATHER, theta - h - edge);
  }
  return member >= 0 || uSkyWrap == SKY_WRAP_WHEEL;
}

// Matches skyWheelFlowTravel in sky-swirl.ts: under wheelflow and wheelrun, -1 for a stroke at
// unit direction dir inside a wheel, which turns as under wheel (skyWheelMotion), else the share
// of its travel along the field it makes, so no moved centre crosses a turning disc's members'
// edge: moved paint overlaps a disc by at most the stroke's own half extent, as a stroke resting
// just outside the edge already does. v is its field
// velocity (omega × dir, at unit distance) and h the angular extent kept clear on top of that: 0
// for a dome stroke, and the haze's half diagonal over its distance, because the haze's rest thin
// already keeps it off the discs (skyHazeWheel). Per wheel within 90° of it: its clearance, the
// sine of its angle past the members' edge (SKY_WHEEL_EDGE_COS, SKY_WHEEL_EDGE_SIN; the sine is
// under the angle) less h, over the most a half loop can bring it nearer the axis,
// SKY_SWIRL_HALF_PERIOD |v·c| / sin θ (the distance to the axis is convex along the great circle
// the stroke travels on, so it falls no faster than its first-order rate), floored at
// SKY_WHEELFLOW_APPROACH_FLOOR of the whole arc so a stroke flowing along the rim eases in rather
// than jumping from still to full travel where its rest centre clears the edge, through
// smoothstep(0, SKY_WHEELFLOW_RAMP), which never exceeds 0.9 of its argument: the stroke travels
// in full once its clearance is SKY_WHEELFLOW_RAMP of that, and holds still at the edge. Then
// the alignment of v with the disc's rim velocity (SKY_WHEELFLOW_SENSE c × dir): 0 opposed or crossways, 1 from SKY_WHEELFLOW_ALIGN, with the speed floored at
// SKY_WHEELFLOW_MIN_SPEED2 so a stagnation point fades to still, in full out to
// SKY_WHEELFLOW_ALIGN_INNER and eased back to 1 by SKY_WHEELFLOW_ALIGN_OUTER. Only the nearest
// wheel's alignment counts, by chord margin past its members' edge, blended with the next
// nearest's over SKY_WHEELFLOW_ALIGN_BLEND of margin difference: the two central wheels turn the
// same way and oppose across their gap, and the blend keeps the switch between them without a
// seam. Per vertex: per wheel a dot, a square root, a divide and a smoothstep, and the alignment's
// cross product, dots and inverse square root for a stroke near a disc.
const float SKY_WHEEL_EDGE_COS[SKY_VORTEX_COUNT] = SKY_WHEEL_EDGE_COSS;
const float SKY_WHEEL_EDGE_SIN[SKY_VORTEX_COUNT] = SKY_WHEEL_EDGE_SINS;
const float SKY_WHEELFLOW_ALIGN_INNER[SKY_VORTEX_COUNT] = SKY_WHEELFLOW_ALIGN_INNERS;
const float SKY_WHEELFLOW_ALIGN_OUTER[SKY_VORTEX_COUNT] = SKY_WHEELFLOW_ALIGN_OUTERS;
const float SKY_WHEELFLOW_SENSE[SKY_VORTEX_COUNT] = SKY_WHEELFLOW_SENSES;
float skyWheelFlowTravel(vec3 dir, vec3 v, float h) {
  float travel = 1.0;
  float near1 = 1e9;
  float near2 = 1e9;
  float align1 = 1.0;
  float align2 = 1.0;
  float speed2 = max(dot(v, v), SKY_WHEELFLOW_MIN_SPEED2);
  float floorRate = SKY_WHEELFLOW_APPROACH_FLOOR * sqrt(dot(v, v));
  for (int i = 0; i < SKY_VORTEX_COUNT; i++) {
    vec3 c = SKY_VORTEX_AXIS[i].xyz;
    float cosine = dot(c, dir);
    float x = 1.0 - cosine;
    if (x < SKY_WHEEL_CORE[i]) return -1.0;
    if (cosine > 0.0) {
      float sine = sqrt(max(1.0 - cosine * cosine, 1e-12));
      float clear = sine * SKY_WHEEL_EDGE_COS[i] - cosine * SKY_WHEEL_EDGE_SIN[i] - h;
      float approach = SKY_SWIRL_HALF_PERIOD * max(abs(dot(v, c)) / sine, floorRate);
      travel *= smoothstep(0.0, SKY_WHEELFLOW_RAMP, clear / max(approach, 1e-9));
    }
    float margin = sqrt(2.0 * x) - sqrt(2.0 * SKY_WHEEL_CORE[i]);
    if (margin < near2) {
      float align = 1.0;
      if (x < SKY_WHEELFLOW_ALIGN_OUTER[i]) {
        vec3 rim = cross(c, dir);
        float cosAlign = SKY_WHEELFLOW_SENSE[i] * dot(rim, v) *
          inversesqrt(max(dot(rim, rim) * speed2, 1e-30));
        align = mix(
          smoothstep(0.0, SKY_WHEELFLOW_ALIGN, cosAlign),
          1.0,
          smoothstep(SKY_WHEELFLOW_ALIGN_INNER[i], SKY_WHEELFLOW_ALIGN_OUTER[i], x)
        );
      }
      if (margin < near1) {
        near2 = near1;
        align2 = align1;
        near1 = margin;
        align1 = align;
      } else {
        near2 = margin;
        align2 = align;
      }
    }
  }
  return travel * mix(
    align2,
    align1,
    smoothstep(-SKY_WHEELFLOW_ALIGN_BLEND, SKY_WHEELFLOW_ALIGN_BLEND, near2 - near1)
  );
}

// Matches skyWheelRunGain in sky-swirl.ts: wheelrun's shrink at the wrap for a stroke making share
// `travel` of its trip, base's envelope scaled up to full by SKY_WHEELRUN_GAIN_TRAVEL of travel (a
// stroke that barely moves jumps back too little to hide), and faded out as calm falls to 0 over
// SKY_WHEELRUN_CALM_FADE, so the sky gate the wheels hold open at calm 0 shows the rest sky outside
// them, not strokes frozen mid-shrink.
float skyWheelRunGain(float f, float travel) {
  return (smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f)) - 1.0) *
    min(1.0, travel * SKY_WHEELRUN_GAIN_TRAVEL) * smoothstep(0.0, SKY_WHEELRUN_CALM_FADE, uCalm);
}

// Matches skyStreamPhase and skyStreamPack in sky-swirl.ts: the stream wrap's loop fraction from
// the stroke's phase byte, and the sign of its long axis l along its flow v = omega × d, the way
// its paint streams (+1 also where the flow is still), packed with the brush as
// sign × (1 + brush + f), which stroke.frag.glsl decodes from vStream. 0 is no stream.
float skyStream(vec3 v, vec3 l, uint brush, float phase, float t) {
  float f = fract(t * SKY_STREAM_INV_PERIOD + phase);
  return (dot(l, v) < 0.0 ? -1.0 : 1.0) * (1.0 + float(brush) + f);
}

// Matches skySwirl in sky-swirl.ts. The field is one rotation vector about SKY_EYE: each vortex
// turns at gamma / max(chord², core²) about its axis (Rankine, no square root), plus the drift about
// the vertical. The stroke sweeps a short arc of it per SKY_SWIRL_PERIOD: forward and back in
// bands under wave, and under base forward only, shrinking to nothing at the wrap. Under wheel the
// cores turn rigidly and the rest holds still (skyWheelMotion), and under stream every stroke holds
// still and hands its loop to the fragment shader (skyStream). Under wheelflow and wheelrun the
// cores turn as under wheel, and outside them each stroke travels as under wave (wheelflow) or base
// (wheelrun), its travel scaled by skyWheelFlowTravel, which keeps flowExtent (metres: the
// haze's half diagonal, 0 for a dome stroke) clear of the wheels on top of the moved centre. n,
// l and s are the stroke's normal and long and short axes, which only wheel turns, and brush its
// brush index (iMeta.x). rigid is the wheel's calm-free offset, 0 unless the wheel
// branch sets it, and stream is vStream, 0 unless the stream branch sets it. Wave is the first
// compare, so it pays one, base two, pingpong three, wheel four, stream five, and wheelflow and
// wheelrun six. SKY_VORTEX_COUNT is a handful (4): each vortex costs a dot, a max, a divide and a
// multiply-add per vertex.
#ifdef VTX_HOIST
// The `vtx` group's hoist arm (src/render/strokes/vertex-arms.ts): the same motion from the
// stroke's rest field, built on the CPU (iSkyField, iSkyWave in stroke.vert.glsl), so only the
// time-dependent part runs per vertex.
Motion skyMotion(
  vec3 p,
  inout vec3 n,
  inout vec3 l,
  inout vec3 s,
  uint brush,
  float phase,
  float t,
  float flowExtent,
  inout vec3 rigid,
  inout float stream
) {
  float amplitude = SKY_SWIRL_PERIOD;
  if (uSkyWrap == SKY_WRAP_WAVE) {
    phase = iSkyWave.x + SKY_WAVE_JITTER * (phase - 0.5);
    amplitude *= iSkyWave.y;
  } else if (uSkyWrap == SKY_WRAP_BASE) {
    float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
    float tau = (f - 0.5) * SKY_SWIRL_PERIOD;
    return Motion(
      tau * iSkyField.xyz,
      tau * iSkyField.w,
      smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f)) - 1.0,
      0.0
    );
  } else if (uSkyWrap != SKY_WRAP_PINGPONG) {
    vec3 d = p - SKY_EYE;
    float inverseDistance = inversesqrt(dot(d, d));
    vec3 dir = d * inverseDistance;
    if (uSkyWrap == SKY_WRAP_WHEEL) return skyWheelMotion(d, dir, n, l, s, t, rigid);
    if (uSkyWrap == SKY_WRAP_STREAM) {
      stream = skyStream(iSkyField.xyz, l, brush, phase, t);
      return Motion(vec3(0.0), 0.0, 0.0, 0.0);
    }
    float travel = skyWheelFlowTravel(
      dir,
      iSkyField.xyz * inverseDistance,
      flowExtent * inverseDistance
    );
    if (travel < 0.0) return skyWheelMotion(d, dir, n, l, s, t, rigid);
    if (uSkyWrap == SKY_WRAP_WHEELRUN) {
      float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
      float tau = (f - 0.5) * SKY_SWIRL_PERIOD * travel;
      return Motion(tau * iSkyField.xyz, tau * iSkyField.w, skyWheelRunGain(f, travel), 0.0);
    }
    phase = iSkyWave.x + SKY_WAVE_JITTER * (phase - 0.5);
    amplitude *= iSkyWave.y * travel;
  }
  float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
  float tau = (smoothstep(0.0, 1.0, 1.0 - abs(2.0 * f - 1.0)) - 0.5) * amplitude;
  return Motion(tau * iSkyField.xyz, tau * iSkyField.w, 0.0, 0.0);
}
#else
Motion skyMotion(
  vec3 p,
  inout vec3 n,
  inout vec3 l,
  inout vec3 s,
  uint brush,
  float phase,
  float t,
  float flowExtent,
  inout vec3 rigid,
  inout float stream
) {
  vec3 d = p - SKY_EYE;
  float inverseDistance = inversesqrt(dot(d, d));
  vec3 dir = d * inverseDistance;
  vec3 omega = vec3(0.0, SKY_DRIFT, 0.0);
  for (int i = 0; i < SKY_VORTEX_COUNT; i++) {
    vec4 v = SKY_VORTEX_AXIS[i];
    omega += v.xyz * (v.w / max(1.0 - dot(v.xyz, dir), SKY_VORTEX_CORE[i]));
  }
  if (uSkyWrap == SKY_WRAP_WAVE) {
    float wavePhase = skyWavePhase(dir) + SKY_WAVE_JITTER * (phase - 0.5);
    return skyWrapMotion(d, omega, n, wavePhase, SKY_SWIRL_PERIOD * skyWaveFade(dir), t);
  }
  if (uSkyWrap == SKY_WRAP_BASE) {
    float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
    float tau = (f - 0.5) * SKY_SWIRL_PERIOD;
    return Motion(
      tau * cross(omega, d),
      tau * dot(omega, n),
      smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f)) - 1.0,
      0.0
    );
  }
  if (uSkyWrap == SKY_WRAP_PINGPONG) return skyWrapMotion(d, omega, n, phase, SKY_SWIRL_PERIOD, t);
  if (uSkyWrap == SKY_WRAP_WHEEL) return skyWheelMotion(d, dir, n, l, s, t, rigid);
  if (uSkyWrap == SKY_WRAP_STREAM) {
    stream = skyStream(cross(omega, d), l, brush, phase, t);
    return Motion(vec3(0.0), 0.0, 0.0, 0.0);
  }
  float travel = skyWheelFlowTravel(dir, cross(omega, dir), flowExtent * inverseDistance);
  if (travel < 0.0) return skyWheelMotion(d, dir, n, l, s, t, rigid);
  if (uSkyWrap == SKY_WRAP_WHEELRUN) {
    float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);
    float tau = (f - 0.5) * SKY_SWIRL_PERIOD * travel;
    return Motion(tau * cross(omega, d), tau * dot(omega, n), skyWheelRunGain(f, travel), 0.0);
  }
  float wavePhase = skyWavePhase(dir) + SKY_WAVE_JITTER * (phase - 0.5);
  return skyWrapMotion(d, omega, n, wavePhase, SKY_SWIRL_PERIOD * skyWaveFade(dir) * travel, t);
}
#endif

// Matches skyRing in sky-rings.ts. The stroke centred at p rings round anchor k (sky-rings.glsl):
// a crest slides it radially out by the swell times its hat, 0 inside the still inner radius and at
// the rim, so no moved centre passes the rim, and brightens it by SKY_RING_GAIN.y from the inner
// radius out and by SKY_RING_GAIN.z inside it. One inverse square root; the distance is clamped so
// the direction never divides by 0.
Motion ringMotion(int k, vec3 p, float t) {
  vec4 c = SKY_RING_CENTRE[k];
  vec4 wave = SKY_RING_WAVE[k];
  vec3 gain = SKY_RING_GAIN[k];
  vec3 d = p - c.xyz;
  float d2 = max(dot(d, d), 1e-6);
  float inv = inversesqrt(d2);
  float r = d2 * inv;
  float w = ringBump(fract(t * c.w + wave.x - r * wave.y));
  float hat = max(r - wave.z, 0.0) * max(wave.w - r, 0.0);
  return Motion((gain.x * w * hat * inv) * d, 0.0, 0.0, w * mix(gain.z, gain.y, step(wave.z, r)));
}

// Per-layer motion of the stroke centred at p with unit normal n, before calm scaling. phase is the
// instance's phase byte as a fraction in [0, 1), t is uTime. The stars and the moon ring by anchor
// (P4.3): a star stroke's phase byte names its star (src/world/sky-lights.ts), clamped so a stray
// byte stays in the table, and every moon stroke rings round the moon. Their rings' phase is per
// anchor, so neither reads the pinned stroke phase, and MOTION_PHASE_PIN leaves them as they are.
Motion starMotion(vec3 p, uint phaseByte, float t) {
  return ringMotion(int(min(phaseByte, uint(SKY_RING_STAR_COUNT - 1))), p, t);
}
// Matches moonRing in sky-rings.ts: a stroke on the crescent's gold (SKY_MOON_STILL_PHASE) stays
// still; every other moon stroke rings and shimmers by its phase byte.
Motion moonMotion(vec3 p, uint phaseByte, float t) {
  if (phaseByte == SKY_MOON_STILL_PHASE) return Motion(vec3(0.0), 0.0, 0.0, 0.0);
  Motion m = ringMotion(SKY_RING_MOON, p, t);
  float f = fract(t * SKY_MOON_SHIMMER_INV_PERIOD + float(phaseByte) * (1.0 / 256.0));
  m.bright += SKY_MOON_SHIMMER * (2.0 * ringBump(f) - 1.0);
  return m;
}
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
// The reactive motion's per-slot constants (reactive.ts): slot 0 is the head and slots 1 and 2 the
// hands, so a hand's small radius and its own gains are constants, not uniforms. The loops below
// have constant bounds, so an unrolling compiler folds each lookup to an immediate.
const float REACTIVE_SLOT_INV_R2[REACTIVE_DISTURBERS] = REACTIVE_INV_RADIUS2;
const float REACTIVE_SLOT_PUSH[REACTIVE_DISTURBERS] = REACTIVE_PUSH_GAIN;
const float REACTIVE_SLOT_DRAG[REACTIVE_DISTURBERS] = REACTIVE_DRAG_S;
const float REACTIVE_SLOT_SWIRL[REACTIVE_DISTURBERS] = REACTIVE_SWIRL;
const float REACTIVE_SLOT_LEVER[REACTIVE_DISTURBERS] = REACTIVE_LEVER;
const float REACTIVE_SLOT_HALF_CAP[REACTIVE_DISTURBERS] = REACTIVE_HALF_CAP;

// Matches reactiveMotion in reactive.ts (P4.5), on every layer behind reactiveGate: each disturber
// pushes the stroke centred at p away by its strength times the falloff (1 - x²)² times
// PUSH_GAIN min(|p - d|, LEVER) along p - d, 0 at the disturber itself, and drags it by its
// velocity times DRAG_S. x is q / R, q the disturber's distance to the stroke's quad (l the long
// axis, halfSize its drawn half-size, capped at HALF_CAP: 0 for the head, so its q is |p - d|); each
// wake sample turns it about its normal n through the sample by weight times SWIRL times the
// falloff. Radius, gain, drag and swirl are the disturber's slot's own, and a wake sample uses its
// disturber's. The rotations' offsets are linear in p - w, so the loop sums t (p - w) and t and
// takes one cross product after it. The sum loses its part along n, so the stroke slides along its
// surface, and is clamped to REACTIVE_REACH; the turn is capped at REACTIVE_MAX_TURN. The gain is
// the push's areal stretch in the tangent plane, (1 + a)(1 + a - tr M) with a = calm Σ G s f² and
// tr M = -calm Σ t · ∇(G s f² m) (t the tangent part of p - d), as a size factor √J, never below
// 1 and capped at 1 + REACTIVE_MAX_GAIN: strokes spread apart grow to keep covering the surface
// (R-P4o). No phase: it is a pure function of p and the field.
// Cost per vertex inside the box, counted in scalar ALU operations: one short-axis cross product
// (6), the head at about 25 (its branch folds away when the loop unrolls), 2 hands of about 75
// (the quad distance, the lever and its stretch term), 24 wake samples of about 15, then a tail of
// about 35 (swirl cross product, normal removal, reach clamp, stretch), about 580 in all, up from
// about 470 with the centre distance (if the loops do not unroll, each lookup is a constant-array
// read and the head pays the branch's test). The P4.6
// desktop record (docs/perf.md, Motion) measures the frame with a controller sweeping inside the
// cypress; the Quest cost is pending the owner (P4.7).
Motion reactiveMotion(vec3 p, vec3 n, vec3 l, vec2 halfSize) {
  vec3 offset = vec3(0.0);
  float spread = 0.0;
  float squeeze = 0.0;
  vec3 sAxis = cross(n, l);
  for (int j = 0; j < REACTIVE_DISTURBERS; j++) {
    vec4 d = uDisturbers[j];
    vec3 e = p - d.xyz;
    float e2 = dot(e, e);
    float en = dot(e, n);
    float tangent = e2 - en * en;
    // The centre distance and no lever, which the head keeps. Its cap is the constant 0, so an
    // unrolled loop drops the branch for slot 0.
    float q2 = e2;
    float qDrop = tangent;
    float m = 1.0;
    float lever = 0.0;
    if (REACTIVE_SLOT_HALF_CAP[j] > 0.0) {
      // A hand's distance to the stroke's quad, its half-size capped, and its push lever.
      vec2 hs = min(halfSize, vec2(REACTIVE_SLOT_HALF_CAP[j]));
      vec2 ax = abs(vec2(dot(e, l), dot(e, sAxis)));
      vec2 inPlane = max(ax - hs, 0.0);
      q2 = e2 - dot(ax - inPlane, ax + inPlane);
      qDrop = tangent - dot(ax, ax - inPlane);
      float ir = inversesqrt(max(e2, 1e-24));
      m = min(1.0, REACTIVE_SLOT_LEVER[j] * ir);
      lever = m < 1.0 ? tangent * ir * ir : 0.0;
    }
    float invR2 = REACTIVE_SLOT_INV_R2[j];
    float f = max(1.0 - q2 * invR2, 0.0);
    float sf = d.w * f;
    float s = sf * f;
    float g = REACTIVE_SLOT_PUSH[j];
    float sg = s * g * m;
    offset += sg * e + (s * REACTIVE_SLOT_DRAG[j]) * uDisturberVelocities[j].xyz;
    spread += sg;
    squeeze += g * m * (4.0 * invR2 * sf * qDrop + s * lever);
  }
  vec3 swirl = vec3(0.0);
  float theta = 0.0;
  for (int j = 0; j < REACTIVE_DISTURBERS; j++) {
    float invR2 = REACTIVE_SLOT_INV_R2[j];
    float k = REACTIVE_SLOT_SWIRL[j];
    for (int i = 0; i < REACTIVE_WAKE_PER_SLOT; i++) {
      vec4 w = uWake[j * REACTIVE_WAKE_PER_SLOT + i];
      vec3 e = p - w.xyz;
      float f = max(1.0 - dot(e, e) * invR2, 0.0);
      float t = w.w * k * f * f;
      swirl += t * e;
      theta += t;
    }
  }
  offset += cross(n, swirl);
  offset -= n * dot(n, offset);
  offset *= min(1.0, REACTIVE_REACH * inversesqrt(max(dot(offset, offset), 1e-12)));
  float a = uCalm * spread;
  float stretch = (1.0 + a) * (1.0 + a - uCalm * squeeze);
  float gain = min(sqrt(max(stretch, 1.0)) - 1.0, REACTIVE_MAX_GAIN);
  return Motion(offset, min(theta, REACTIVE_MAX_TURN), gain, 0.0);
}

// Matches motionOffset in motion.ts. Only called behind the gate: layerMoves is the layer's own
// motionGate and reacts the reactiveGate, at least one true. The layer motion runs only behind its
// bit and the reactive motion only behind its gate. Their offsets, turns and brightnesses add; their
// gains combine as size factors, so a wrapping stroke still shrinks to nothing and a stretched one
// grows. MOTION_PHASE_PIN is the e2e's coherent phase
// (material.ts pinMotionPhase), never defined in a production build. flame is the instance's
// colour alpha, which only the cypress reads (P4.4). n, l and s are its normal and long and short
// axes and brush its brush index, which only the sky reads, and only the wheel turns n, l and s
// (skyWheelMotion); halfSize is its drawn half size, which the reactive motion reads, and
// flowExtent what wheelflow and wheelrun keep clear of the wheels (skyMotion); stream is
// vStream, which only the sky's stream wrap sets (skyStream). The wheel's rigid offset is added after the calm scaling.
Motion motionOffset(
  uint layer,
  vec3 p,
  inout vec3 n,
  inout vec3 l,
  inout vec3 s,
  uint phaseByte,
  uint brush,
  float flame,
  bool layerMoves,
  bool reacts,
  vec2 halfSize,
  float flowExtent,
  inout float stream
) {
#ifdef MOTION_PHASE_PIN
  float phase = MOTION_PHASE_PIN;
#else
  float phase = float(phaseByte) * (1.0 / 256.0);
#endif
  float t = uTime;
  Motion m = Motion(vec3(0.0), 0.0, 0.0, 0.0);
  vec3 rigid = vec3(0.0);
  if (!layerMoves) {
  } else if (layer == STROKE_LAYER_SKY) {
    m = skyMotion(p, n, l, s, brush, phase, t, flowExtent, rigid, stream);
  } else if (layer == STROKE_LAYER_STAR) {
    m = starMotion(p, phaseByte, t);
  } else if (layer == STROKE_LAYER_MOON) {
    m = moonMotion(p, phaseByte, t);
  } else if (layer == STROKE_LAYER_CYPRESS) {
    m = cypressMotion(p, n, phase, flame, t);
  }
  if (reacts) {
    Motion r = reactiveMotion(p, n, l, halfSize);
    m.offset += r.offset;
    m.turn += r.turn;
    m.gain = (1.0 + m.gain) * (1.0 + r.gain) - 1.0;
    m.bright += r.bright;
  }
  m = scaleMotion(m, uCalm);
  m.offset += rigid;
  return m;
}

// Matches motionReach in motion.ts: how far, metres, the open gate can move the stroke centred at p
// from rest, calm included. Only called behind motionGate, for the haze's sky-light thin, so only
// the sky layer's reach is here: no star or moon stroke carries SKY_LIGHT_CULL_FLAG, and their
// rings stay inside the cones' rim (sky-rings.ts). The haze is the only sky stroke with that flag.
// It holds still under stream, so its reach is 0 there. Outside the wheels under wheelflow and
// wheelrun it travels at most as under wave and base, so it keeps their reach. Never called under
// wheel, or for a haze stroke in a wheel under wheelflow and wheelrun, where the thin is judged at
// the turned centre instead (skyHazeWheel).
float motionReach(uint layer, vec3 p) {
  if (layer != STROKE_LAYER_SKY || uSkyWrap == SKY_WRAP_STREAM) return 0.0;
  return uCalm * SKY_SWIRL_MAX_ANGLE * length(p - SKY_EYE);
}

// Matches reactiveReach in motion.ts: the farthest, metres, the reactive motion moves a stroke,
// calm included. Only called behind reactiveGate, for the haze's sky-light thin (R-P4b).
float reactiveReach() { return uCalm * REACTIVE_REACH; }
