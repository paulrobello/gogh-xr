/**
 * The settings panel's palette and type scale, shared by the XR panel and the DOM mirror (P5.3).
 * A low-glare night blue from the painting with the teleport arc's warm yellow as the one active
 * accent. Type sizes are metres at panel scale 1, for reading at 0.6-1.0 m.
 */
export const PANEL_COLORS = Object.freeze({
  backing: 0x0a1226,
  frame: [0x3b, 0x5e, 0xa8] as const,
  idle: [0x5d, 0x76, 0xa8] as const,
  track: [0x2c, 0x3f, 0x6a] as const,
  hover: [0xa8, 0xc0, 0xe8] as const,
  active: [0xf2, 0xc8, 0x4b] as const,
  locked: [0x6b, 0x64, 0x60] as const,
  disabled: [0x2b, 0x35, 0x50] as const,
  title: 0xe8ecf6,
  label: 0xc9d3ea,
  header: 0x7f97c9,
  value: 0x9fb2d8,
  onActive: 0x0a1226,
  note: 0xe0c27a,
  muted: 0x5f6a86,
  tooltip: 0x141f3d,
});

export const PANEL_TYPE = Object.freeze({
  title: 0.024,
  header: 0.016,
  label: 0.017,
  value: 0.016,
  segment: 0.016,
  button: 0.018,
  tooltip: 0.015,
});
