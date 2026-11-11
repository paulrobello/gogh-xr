// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and BRUSH_COUNT (defines).
precision highp float;
precision highp int;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// The eye of the view being drawn: three sets it from each camera's matrixWorld, next to viewMatrix,
// so each XR eye has its own.
uniform vec3 cameraPosition;
// Per brush: atlas uv min corner (xy) and size (zw), from brushUvRect().
uniform vec4 uBrushRects[BRUSH_COUNT];
// Distance-band stroke-size multiplier (P1.4).
uniform float uSizeScale;
// Moon and star discs (src/render/strokes/sky-light-cull.ts): world centre xyz, radius w in
// metres; w = 0 is an unused slot. Each cone's feather, metres past its radius on the dome.
uniform vec4 uSkyLightCones[SKY_LIGHT_CONES];
uniform float uSkyLightFeathers[SKY_LIGHT_CONES];
// Boundary haze thickening, 0-1 (material.ts uHazeThickness): the haze is the sky layer's only
// SKY_LIGHT_CULL_FLAG strokes.
uniform float uHazeThickness;
// The `vtx` A/B group's `smaller` scale (src/render/strokes/vertex-arms.ts): 1.0 on every other
// arm and on every material outside the stroke batch, and a multiply by 1.0 is exact.
uniform float uVtxSize;

// Unit quad corner in [-0.5, 0.5]²: x along the stroke, y across it.
in vec3 position;
in vec3 iPosition;
in vec2 iNormal;
in float iTangent;
in vec4 iColor;
in vec2 iSize;
in uvec4 iMeta;
// The depth key's top 24 bits as an exact float (tie-key.ts tieKeys), which every stroke geometry
// carries: the size hash of a ranked stroke off the backdrop, else the position hash.
in float iTie;
// The sky river (sky-river.ts skyRiverInstancesSteps): xyz the stroke's rotation vector, w the
// forward-and-back phase. Read only by the river arms; a geometry without it reads 0.
in vec4 iRiver;
#ifdef VTX_HOIST
// The `hoist` arm's sky field at rest (vertex-arms.ts skyStatic): xyz omega × d and w omega · n,
// the swirl's sweep and turn per unit of tau; and the wave wrap's loop phase and amplitude at the
// stroke's direction. Zero off the sky layer.
in vec4 iSkyField;
in vec2 iSkyWave;
#endif

out vec2 vUv;
flat out vec3 vColor;
// Brush uv rect as (min.xy, max.xy), for clamping relief taps.
flat out vec4 vRect;
flat out vec3 vNormal;
flat out vec3 vLong;
flat out vec3 vShort;
// The sky's stream wrap (motion.glsl skyStream): sign × (1 + brush + f), with f its loop fraction,
// the sign the way its paint streams along u and the brush the one whose tone correlation
// stroke.frag.glsl reads. 0, no stream, for every other stroke and wrap.
flat out float vStream;

// #include sky-rings.glsl (src/motion/sky-rings.glsl, spliced in by material.ts)
// #include motion.glsl (src/motion/motion.glsl, spliced in by material.ts)

// Matches octDecode in instance.ts.
vec3 octDecode(vec2 e) {
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    vec2 s = vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
    v.xy = (1.0 - abs(v.yx)) * s;
  }
  return normalize(v);
}

// Duff et al. 2017 branchless basis; matches surfaceBasis in frame.ts. sign() would be 0 at n.z = 0.
void surfaceBasis(vec3 n, out vec3 b1, out vec3 b2) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float b = n.x * n.y * a;
  b1 = vec3(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  b2 = vec3(b, s + n.y * n.y * a, -n.y);
}

// Matches skyLightThin in sky-light-cull.ts: 0 when the stroke centre p, seen from this view's
// eye, lies inside a disc's cone widened by the stroke's own drawn half diagonal; past that edge,
// the product over the cones of a smoothstep of the angular gap over each cone's feather.
float skyLightThin(vec3 p, float halfExtent) {
  vec3 eye = cameraPosition;
  vec3 h = p - eye;
  float lenH = length(h);
  float sinB = min(1.0, halfExtent / lenH);
  float cosB = sqrt(1.0 - sinB * sinB);
  // The angle k = 2 beta + SKY_LIGHT_MIN_FEATHER. A cone's factor is exactly 1 from outer + k on,
  // the feather's far end or past it, which stays under pi while beta <= pi / 6.
  float cos2B = 1.0 - 2.0 * sinB * sinB;
  float sin2B = 2.0 * sinB * cosB;
  float cosK = cos2B * SKY_LIGHT_MIN_FEATHER_COS - sin2B * SKY_LIGHT_MIN_FEATHER_SIN;
  float sinK = sin2B * SKY_LIGHT_MIN_FEATHER_COS + cos2B * SKY_LIGHT_MIN_FEATHER_SIN;
  bool early = sinB <= 0.5;
  float thin = 1.0;
  for (int i = 0; i < SKY_LIGHT_CONES; i++) {
    vec4 cone = uSkyLightCones[i];
    if (cone.w <= 0.0) continue;
    vec3 a = cone.xyz - eye;
    float lenA = max(length(a), 1e-3);
    float d = dot(a, h);
    float sinO = min(1.0, (cone.w + uSkyLightFeathers[i]) / lenA);
    float cosO = sqrt(1.0 - sinO * sinO);
    if (early && sinO < 1.0 && d <= (cosO * cosK - sinO * sinK) * lenA * lenH) continue;
    float sinA = min(1.0, cone.w / lenA);
    float cosA = sqrt(1.0 - sinA * sinA);
    if (d > (cosA * cosB - sinA * sinB) * lenA * lenH) return 0.0;
    float beta = asin(sinB);
    float alpha = asin(sinA);
    float feather = max(SKY_LIGHT_MIN_FEATHER, asin(sinO) - alpha + beta);
    float gap = acos(clamp(d / (lenA * lenH), -1.0, 1.0)) - alpha - beta;
    thin *= smoothstep(0.0, feather, gap);
  }
  return thin;
}

void main() {
  vec3 n = octDecode(iNormal);
  vec3 b1;
  vec3 b2;
  surfaceBasis(n, b1, b2);
  float theta = iTangent * 6.28318530718;
  vec3 longAxis = cos(theta) * b1 + sin(theta) * b2;
  vec3 shortAxis = cross(n, longAxis);

  // A face-clamped stroke caps the band's size factor at its fit level, so it stays inside its
  // face at any band (src/render/strokes/face-clamp.ts). Level 0 is no cap.
  uint fitLevel = (iMeta.w >> FIT_SCALE_SHIFT) & FIT_SCALE_MASK;
  float sizeScale = fitLevel == 0u
    ? uSizeScale
    : min(uSizeScale, 1.0 + float(fitLevel - 1u) * FIT_SCALE_STEP);
  if (iMeta.y == STROKE_LAYER_SKY && (iMeta.w & SKY_LIGHT_CULL_FLAG) != 0u) {
    sizeScale *= 1.0 + HAZE_GROWTH * uHazeThickness;
  }
  vec2 size = iSize * sizeScale * uVtxSize;
  // Boundary haze thins toward the moon and stars (sky-light-cull.ts): the drawn size scales by
  // the square root of the factor, so the quad's area follows it. Judged at the full size, haze
  // growth included, so a shrunk quad stays out of the disc cone at any thickness. The thin is
  // judged at rest, before the motion (R-P4b): an open gate widens the stroke by its motion reach,
  // the farthest the motion can carry its centre, so a moved quad at its judged size stays inside
  // the judged extent and out of the disc cone. The reactive stretch growth (P4.5) comes after the
  // thin, so a grown haze quad can reach past that extent. It still stays out of the cone: a haze
  // stroke grows only with its centre within 0.6 m of the head or 0.696 m of a hand (its half-size
  // is past the hand's 0.4 m cap), so within about 1.5 m of the eye for a hand within about 0.8 m,
  // and its rest half-diagonal is at least 1.62 m (boundary.ts HAZE_STROKE_SIZE 3 x 1.2, every band
  // size >= 1), so its sinB is 1 and the thin was already the coarse hemisphere cut. This holds
  // while the hand is within about 1 m of the eye; a controller set down farther away inside the
  // haze shell could grow a haze stroke over a disc. Widening the thin by the growth cap would turn
  // the coarse cut on for in-box haze out to about 3.4 m, so haze would vanish near a hand.
  // The haze around a disc then clears a little wider while the sky moves, rather than paying the
  // motion before the thin for every haze stroke. Two wraps differ: under stream no stroke moves,
  // so the reach is 0 and the thin is the rest thin, and under wheel (and for a haze stroke in a
  // kept wheel under the river arms) the haze's rigid turn runs first (motion.glsl
  // skyHazeWheel), so the thin is judged at the turned centre with no reach.
  // The motion gates (P4.1, P4.5): the layer's own bit, and the reactive bit with the rest centre
  // inside the reactive box. Closed, as under ?noanim or at calm 0, each is one AND and compare.
  bool layerMoves = motionGate(iMeta.y);
  bool reacts = reactiveGate(iPosition);
  float thin = 1.0;
  vec3 wheel = vec3(0.0);
  bool wheelTurned = false;
  // The extent the river arms keep clear of the wheels on top of the moved centre: the
  // haze's full-size half diagonal, since its rest thin keeps it off the discs, and 0 otherwise.
  float flowExtent = 0.0;
  if ((iMeta.w & SKY_LIGHT_CULL_FLAG) != 0u) {
    float halfExtent = 0.5 * length(size);
    flowExtent = halfExtent;
    float reach = reacts ? reactiveReach() : 0.0;
    if (layerMoves) {
      // Under wheel, and in a kept wheel under the river arms, the haze turns with its wheel
      // here and is judged where the turn has carried it, thinned clear of the other wheels
      // (motion.glsl skyHazeWheel); otherwise it widens by its motion reach.
      wheelTurned = skyHazeWheel(iPosition, halfExtent, n, longAxis, shortAxis, wheel, thin);
      if (!wheelTurned) reach += motionReach(iMeta.y, iPosition);
    }
    thin *= skyLightThin((modelMatrix * vec4(iPosition + wheel, 1.0)).xyz, halfExtent + reach);
    size *= sqrt(thin);
  }
  vec3 local = iPosition + longAxis * (position.x * size.x) + shortAxis * (position.y * size.y);
  // iColor.a never draws: under alpha-to-coverage, alpha below 1 inside a stroke dithers (R3). It
  // carries a cypress stroke's flame data, read only behind the motion gate (P4.4).
  vec3 color = iColor.rgb;
  float stream = 0.0;
  // Motion (P4.1): the two gates and one branch for a stroke whose layer is still and that is
  // outside the reactive box, or for every stroke while frozen or at calm 0, and none for a
  // thinned-out haze stroke. The motion is the centre's, the same at every corner; the corner work
  // is the turn of the axes. The depth hashes below keep reading the rest iPosition, so a moving
  // stroke keeps its depth order.
  if ((layerMoves || reacts) && thin > 0.0) {
    // Only the sky's wheel turns the normal and the axes (motion.glsl skyWheelMotion), and only
    // its stream sets stream. A haze stroke the wheel already turned above takes no second turn.
    Motion m = motionOffset(
      iMeta.y,
      iPosition,
      n,
      longAxis,
      shortAxis,
      iMeta.z,
      iMeta.x,
      iColor.a,
      layerMoves && !wheelTurned,
      reacts,
      0.5 * size,
      flowExtent,
      stream
    );
    // The turn is at most SKY_RIVER_MAX_TURN (0.625, the river arms; 0.4 under the vortex
    // field's wraps) plus REACTIVE_MAX_TURN (0.5), so cosine and sine are polynomials: at 1.125
    // the turn falls 3.1° short and the quad shrinks to 0.961. This pair has c² + s² <= 1 up to
    // √3, so a turned quad never outgrows its rest extent.
    float a2 = m.turn * m.turn;
    float c = 1.0 - 0.5 * a2;
    float s = m.turn * (1.0 - a2 * (1.0 / 6.0));
    vec3 turned = c * longAxis + s * shortAxis;
    shortAxis = c * shortAxis - s * longAxis;
    longAxis = turned;
    size *= 1.0 + m.gain;
    local = iPosition + wheel + m.offset + longAxis * (position.x * size.x) +
      shortAxis * (position.y * size.y);
    // The star and moon rings' crest (P4.3); 0 for every other layer.
    color *= 1.0 + m.bright;
  }
#ifdef VTX_HOIST
  // The hoist arm drops a chunk mesh's identity model matrix and applies the view before the
  // projection, so no vertex multiplies the projection by the view.
  gl_Position = projectionMatrix * (viewMatrix * vec4(local, 1.0));
#else
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(local, 1.0));
#endif
  // Depth tie-break (src/render/strokes/depth-tie-break.ts): each stroke moves towards the eye by
  // a stable random share of the range, in clip z. Only gl_Position changes, so early-z holds.
  // The range is DEPTH_TIE_BREAK_STEPS window-depth steps (2^-23 in NDC z each), capped at
  // DEPTH_TIE_BREAK_MAX_M metres of view depth; -projectionMatrix[3][2] is 2fn / (f - n). Behind
  // the eye (w <= 0) the cap's 1 / w is unbounded, so the step term alone applies there.
  float w = gl_Position.w;
  float steps = DEPTH_TIE_BREAK_NDC * w;
  float range = w > 0.0 ? min(steps, -projectionMatrix[3][2] * DEPTH_TIE_BREAK_MAX_M / w) : steps;
  // The depth key (tie-key.ts): u the tie-break share, and on the backdrop h8, the position hash's
  // top 24 bits, which the rank reads. A ranked stroke off the backdrop keys on its stored quad
  // size, the share its lift took (depth-tie-break.ts), so lift and tie-break order it alike.
  uint h8 = uint(iTie);
  float u = iTie * (1.0 / 16777216.0);
  if ((iMeta.w & DEPTH_BACKDROP_FLAG) != 0u) {
    // Sky dome (src/render/strokes/backdrop-depth.ts): a constant NDC z just in front of the far
    // plane, nearer by BACKDROP_RANK_NDC per rank, so dome strokes keep one order by hash rank and
    // sit behind the whole world. Clip z = w × ndc keeps perspective-correct varyings. The moon
    // and star layers take the front tier, the BACKDROP_FRONT_RANKS ranks past the dome's.
    bool front = iMeta.y == STROKE_LAYER_STAR || iMeta.y == STROKE_LAYER_MOON;
    float rank = front
      ? float(BACKDROP_DOME_RANKS + (h8 >> (BACKDROP_FRONT_RANK_SHIFT - 8u)))
      : float(h8 >> (BACKDROP_RANK_SHIFT - 8u));
    gl_Position.z = gl_Position.w * (BACKDROP_FAR_NDC - rank * BACKDROP_RANK_NDC);
  } else {
    // Lit windows sit just proud of their wall: the whole range keeps almost every wall stroke
    // behind.
    gl_Position.z -= range * ((iMeta.w & DEPTH_TIE_BREAK_FRONT_FLAG) != 0u ? 1.0 : u);
  }

#ifdef VTX_HOIST
  // A chunk mesh's model matrix is the identity, and the axes are unit to within rounding, or
  // within a sub-percent length change under the motion turn's polynomial cosine and sine.
  vNormal = n;
  vLong = longAxis;
  vShort = shortAxis;
#else
  mat3 toWorld = mat3(modelMatrix);
  vNormal = normalize(toWorld * n);
  vLong = normalize(toWorld * longAxis);
  vShort = normalize(toWorld * shortAxis);
#endif

  vec4 rect = uBrushRects[min(iMeta.x, uint(BRUSH_COUNT - 1))];
  vUv = rect.xy + rect.zw * (position.xy + 0.5);
  vRect = vec4(rect.xy, rect.xy + rect.zw);
  vColor = color;
  vStream = stream;

  // Last, after every other output.
  if (thin <= 0.0) {
    // Every corner outside the clip volume: the quad draws nothing.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
}
