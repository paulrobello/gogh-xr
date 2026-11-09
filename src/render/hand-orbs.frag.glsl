// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the material defines
// (ORB_CORE and ORB_GLOW, metres at scale 1; CORE_SHARE and HALO_SHARE, the two terms' weights).
precision highp float;

// three sets cameraPosition for each XR view it renders.
uniform vec3 cameraPosition;
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uGain;
// The orb's scale: the glow grows with it while the hand moves.
uniform float uScale;

in vec3 vWorld;
flat in vec3 vCentre;

out vec4 fragColor;

void main() {
  // The glow depends only on how close the eye ray passes to the centre, so it reads as a lit ball
  // from any side, with no facet showing.
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 toCentre = vCentre - cameraPosition;
  float along = dot(toCentre, dir);
  // A back face drawn with the eye inside the mesh: nothing glows behind the eye.
  if (along < 0.0) discard;
  float b2 = max(dot(toCentre, toCentre) - along * along, 0.0);
  float glow2 = ORB_GLOW * ORB_GLOW * uScale * uScale;
  float t2 = b2 / glow2;
  if (t2 >= 1.0) discard;
  // A bright soft core of about ORB_CORE, then a halo that reaches 0 at ORB_GLOW with no edge.
  float core = exp(-b2 / (ORB_CORE * ORB_CORE * uScale * uScale));
  float h = 1.0 - t2;
  float halo = h * h * h;
  float glow = uGain * (CORE_SHARE * core + HALO_SHARE * halo);
  fragColor = vec4(mix(uColor, uCoreColor, core), glow);
}
