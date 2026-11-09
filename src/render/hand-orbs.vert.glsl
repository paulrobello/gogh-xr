// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the material defines.
precision highp float;

// three sets viewMatrix for each XR view it renders, so it holds that eye's own view.
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;

out vec3 vWorld;
// The orb's centre, world. The orb's world matrix is a pure translation.
flat out vec3 vCentre;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vCentre = modelMatrix[3].xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
