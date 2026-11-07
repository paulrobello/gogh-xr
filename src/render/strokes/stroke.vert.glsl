// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and BRUSH_COUNT (defines).
precision highp float;
precision highp int;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// Per brush: atlas uv min corner (xy) and size (zw), from brushUvRect().
uniform vec4 uBrushRects[BRUSH_COUNT];
// Distance-band stroke-size multiplier (P1.4).
uniform float uSizeScale;

// Unit quad corner in [-0.5, 0.5]²: x along the stroke, y across it.
in vec3 position;
in vec3 iPosition;
in vec2 iNormal;
in float iTangent;
in vec4 iColor;
in vec2 iSize;
in uvec4 iMeta;

out vec2 vUv;
flat out vec3 vColor;
// Brush uv rect as (min.xy, max.xy), for clamping relief taps.
flat out vec4 vRect;
flat out vec3 vNormal;
flat out vec3 vLong;
flat out vec3 vShort;

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

uint lowbias32(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

void main() {
  vec3 n = octDecode(iNormal);
  vec3 b1;
  vec3 b2;
  surfaceBasis(n, b1, b2);
  float theta = iTangent * 6.28318530718;
  vec3 longAxis = cos(theta) * b1 + sin(theta) * b2;
  vec3 shortAxis = cross(n, longAxis);

  vec2 size = iSize * uSizeScale;
  vec3 local = iPosition + longAxis * (position.x * size.x) + shortAxis * (position.y * size.y);
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(local, 1.0));
  // Depth tie-break (src/render/strokes/depth-tie-break.ts): each stroke moves towards the eye by
  // a stable random share of the range, in clip z. Only gl_Position changes, so early-z holds.
  // The range is DEPTH_TIE_BREAK_STEPS window-depth steps (2^-23 in NDC z each), capped at
  // DEPTH_TIE_BREAK_MAX_M metres of view depth; -projectionMatrix[3][2] is 2fn / (f - n). Behind
  // the eye (w <= 0) the cap's 1 / w is unbounded, so the step term alone applies there.
  float w = gl_Position.w;
  float steps = DEPTH_TIE_BREAK_NDC * w;
  float range = w > 0.0 ? min(steps, -projectionMatrix[3][2] * DEPTH_TIE_BREAK_MAX_M / w) : steps;
  uint h = lowbias32(
    floatBitsToUint(iPosition.x) ^
      lowbias32(floatBitsToUint(iPosition.y) ^ lowbias32(floatBitsToUint(iPosition.z)))
  );
  float u = float(h >> 8u) * (1.0 / 16777216.0);
  if ((iMeta.w & DEPTH_BACKDROP_FLAG) != 0u) {
    // Sky dome (src/render/strokes/backdrop-depth.ts): a constant NDC z just in front of the far
    // plane, nearer by BACKDROP_RANK_NDC per rank, so dome strokes keep one order by hash rank and
    // sit behind the whole world. Clip z = w × ndc keeps perspective-correct varyings.
    float rank = float(h >> BACKDROP_RANK_SHIFT);
    gl_Position.z = gl_Position.w * (BACKDROP_FAR_NDC - rank * BACKDROP_RANK_NDC);
  } else {
    // Lit windows sit just proud of their wall: the whole range keeps almost every wall stroke
    // behind.
    gl_Position.z -= range * ((iMeta.w & DEPTH_TIE_BREAK_FRONT_FLAG) != 0u ? 1.0 : u);
  }

  mat3 toWorld = mat3(modelMatrix);
  vNormal = normalize(toWorld * n);
  vLong = normalize(toWorld * longAxis);
  vShort = normalize(toWorld * shortAxis);

  vec4 rect = uBrushRects[min(iMeta.x, uint(BRUSH_COUNT - 1))];
  vUv = rect.xy + rect.zw * (position.xy + 0.5);
  vRect = vec4(rect.xy, rect.xy + rect.zw);
  // iColor.a is reserved: under alpha-to-coverage, alpha below 1 inside a stroke dithers (R3).
  vColor = iColor.rgb;
}
