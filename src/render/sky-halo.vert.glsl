// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the halo defines
// (skyHaloGlslDefines in src/motion/sky-rings.ts). One instance per sky anchor: gl_InstanceID
// indexes the same ring tables the stroke shader reads.
precision highp float;
precision highp int;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// The motion clock's uniforms (src/motion/clock.ts), the stroke materials' own objects.
uniform float uTime;
uniform float uCalm;
uniform uint uMotionLayers;

// xy a unit direction, z 0 on the hole's corners and 1 on the outer corners (skyHaloRing in
// sky-halo.ts); the outer corners already carry the octagon's corner factor.
in vec3 position;

// The point on the halo's plane, metres from the anchor's centre.
out vec2 vLocal;
flat out vec3 vColor;
// The wave's phase at the centre, in [0, 1), and per metre of radius.
flat out float vPhase;
flat out float vInvWave;
// The glow's peak radius and half-width, metres, swell included.
flat out vec2 vBand;
flat out float vRest;
flat out float vRing;

// #include sky-rings.glsl

// Per anchor: rest peak radius and half-width (metres), rest and ring brightness; and the tint.
const vec4 SKY_HALO[SKY_RING_COUNT] = SKY_HALOS;
const vec3 SKY_HALO_COLOUR[SKY_RING_COUNT] = SKY_HALO_COLOURS;

// Matches skyHaloState in sky-rings.ts. The halo lies on the dome's tangent plane at its anchor,
// as the anchor's strokes do, so its rings sit on theirs from any eye. A closed gate (frozen, calm
// 0, or no world) draws the rest halo at any uTime. The hole's corners sit at the glow's inner
// zero, so the moon's crescent inside it shades no halo fragment; a star's hole is its centre.
void main() {
  int k = gl_InstanceID;
  vec4 c = SKY_RING_CENTRE[k];
  vec4 wave = SKY_RING_WAVE[k];
  vec4 halo = SKY_HALO[k];
  uint bit = 1u << (k == SKY_RING_MOON ? STROKE_LAYER_MOON : STROKE_LAYER_STAR);
  float live = (uMotionLayers & bit) != 0u ? uCalm : 0.0;
  float phase = fract(uTime * c.w + wave.x);
  float swell = 1.0 + live * SKY_HALO_SWELL * ringBump(fract(phase - halo.x * wave.y));
  vec2 band = halo.xy * swell;
  float radius = mix(max(band.x - band.y, 0.0), band.x + band.y, position.z);
  vec2 local = position.xy * radius;
  vec3 n = normalize(c.xyz - SKY_HALO_EYE);
  vec3 u = normalize(cross(n, vec3(0.0, 1.0, 0.0)));
  vec3 v = cross(u, n);
  vec3 world = c.xyz + local.x * u + local.y * v;
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(world, 1.0));
  // Over the dome and the moon and star strokes, behind the whole world (SKY_HALO_NDC).
  gl_Position.z = gl_Position.w * SKY_HALO_NDC;
  vLocal = local;
  vColor = SKY_HALO_COLOUR[k];
  vPhase = phase;
  vInvWave = wave.y;
  vBand = band;
  vRest = halo.z;
  vRing = live * halo.w;
}
