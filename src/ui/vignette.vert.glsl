// GLSL ES 3.00. three prepends `#version 300 es` (glslVersion: GLSL3) and the material defines.
precision highp float;

// three sets modelViewMatrix for each XR view it renders, so it holds that eye's own view.
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;

// The vertex in the rendering eye's view space. Interpolated linearly, which is exact on a facet.
out vec3 vView;

void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vView = view.xyz;
  gl_Position = projectionMatrix * view;
}
