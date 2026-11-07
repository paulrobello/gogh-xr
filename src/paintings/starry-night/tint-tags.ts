/**
 * The village tint tags, with no imports, so `src/world/village.ts` can tag its geometry without
 * pulling the tint bands' histogram and stroke-shader imports into Node loaders (the e2e specs
 * import the village to place their poses). `village-tint.ts` re-exports these.
 */

/** What a village triangle is painted as. */
export const TINT_ROLE = Object.freeze({ wall: 0, roof: 1, churchWall: 2 } as const);
export type TintRole = (typeof TINT_ROLE)[keyof typeof TINT_ROLE];

/**
 * Per-triangle paint tags on a village geometry, in `userData.tint`: the owning house (the church
 * is owner 0 of its own layer) and the role.
 */
export interface TintTags {
  readonly owner: Uint16Array;
  readonly role: Uint8Array;
}
