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
