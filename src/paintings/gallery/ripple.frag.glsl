// The gallery ripple's UV warp (ripple.ts), spliced into the live scan's MeshBasicMaterial after
// `#include <common>`. ripple.ts prepends the RIPPLE_* constants as defines and mirrors this
// function in `rippleWarp`. Every uv here is texture uv; uRippleMetres turns a uv step into metres
// on the canvas along u and v.
uniform vec4 uRipple[2]; // xy: contact, texture uv. z: strength times amplitude. w: radius, metres.
uniform vec4 uRippleCrop; // the scan's crop window: u0, v0, u1, v1.
uniform vec2 uRippleMetres;
uniform float uRippleTime; // seconds, wrapped at RIPPLE_TIME_WRAP.

// `uv` exactly when no contact has a strength above 0 or none reaches it, so a scan at rest draws
// as the plain material does. `glow` gains the faint brightening near each centre.
vec2 galleryRipple(vec2 uv, inout float glow) {
  vec2 shift = vec2(0.0);
  bool moved = false;
  for (int i = 0; i < 2; i++) {
    vec4 c = uRipple[i];
    if (c.z > 0.0) {
      vec2 d = (uv - c.xy) * uRippleMetres;
      float r2 = dot(d, d);
      if (r2 < c.w * c.w) {
        float r = sqrt(r2);
        float x = r / c.w;
        float f = 1.0 - x * x;
        f *= f;
        // The swirl: the paint turns about the contact, most at the centre, with a spiral wave
        // running out through the twist.
        float breath = sin(RIPPLE_TAU * (uRippleTime / RIPPLE_SWIRL_PERIOD - r / RIPPLE_SWIRL_WAVELENGTH));
        float turn = c.z * RIPPLE_SWIRL * f * (1.0 + RIPPLE_SWIRL_WOBBLE * breath);
        float cs = cos(turn);
        float sn = sin(turn);
        shift += vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y) - d;
        // The rings: a radial wave travelling outward, faded in over RIPPLE_RING_INNER.
        float wave = sin(RIPPLE_TAU * (r / RIPPLE_RING_WAVELENGTH - uRippleTime / RIPPLE_RING_PERIOD));
        float ring = c.z * RIPPLE_RING_AMPLITUDE * wave * f * smoothstep(0.0, RIPPLE_RING_INNER, r);
        shift += d * (ring / max(r, 1e-6));
        glow += c.z * RIPPLE_GLOW * f * f;
        moved = true;
      }
    }
  }
  if (!moved) return uv;
  // The warp fades to 0 over RIPPLE_EDGE inside the scan's edge, so the edge meets the still
  // moulding, and the clamp keeps every sample inside the crop window.
  vec2 lo = (uv - uRippleCrop.xy) * uRippleMetres;
  vec2 hi = (uRippleCrop.zw - uv) * uRippleMetres;
  float edge = smoothstep(0.0, RIPPLE_EDGE, min(min(lo.x, lo.y), min(hi.x, hi.y)));
  glow *= edge;
  return clamp(uv + shift * edge / uRippleMetres, uRippleCrop.xy, uRippleCrop.zw);
}
