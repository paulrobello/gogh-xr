/**
 * In-headset A/B groups: one button cycles the active group's variants live, from the same pose,
 * with no reload. Each group's `apply` is reversible at runtime. `?ab=<group>` activates a group,
 * and each older A/B flag implies its own group (`resolveAb`). One group is active at a time.
 *
 * Any new A/B flag registers its group here (CLAUDE.md, URL flags).
 *
 * The button is the `abCycle` action (src/xr/input.ts): a single left-stick click in XR, V on the
 * desktop. main.ts builds a controller only when a group resolves, so a boot with no A/B flag
 * builds no group and does no per-frame A/B work. The bench ignores all of it.
 */
import { FLAME_SWAYS, type FlameSway, SKY_WRAPS, type SkyWrap } from '../motion/variants';
import { ZDIAG_MODES, type ZdiagMode } from './flags';

const SHIMMER = ['base', 'nowrite', 'noa2c', 'sharp', 'sharp4', 'freeze'] as const;

/** Every group's variants, in cycle order. The first is the default the group starts at. */
export const AB_GROUPS = {
  /** The `?zdiag` modes the headset shimmer A/B compares (docs/verification.md). */
  shimmer: SHIMMER,
  /** Every `?zdiag` mode. */
  'zdiag-all': ['base', ...ZDIAG_MODES],
  /** The star and moon halo pass (`?nohalo`). */
  halo: ['on', 'off'],
  /** The motion calm (`?calm`). */
  calm: ['1', '0.5', '0.25'],
  /** The sky swirl's wrap treatment (`?wrap`, src/motion/variants.ts). */
  wrap: SKY_WRAPS,
  /** The cypress sway (`?flame`, src/motion/variants.ts). */
  flame: FLAME_SWAYS,
} as const satisfies Record<string, readonly string[]>;

export type AbGroupName = keyof typeof AB_GROUPS;

type AbSetting = 'zdiag' | 'halo' | 'calm' | 'wrap' | 'flame';

/** The setting each group drives. Two groups that drive the same setting are rivals. */
const OWNS: Record<AbGroupName, AbSetting> = {
  shimmer: 'zdiag',
  'zdiag-all': 'zdiag',
  halo: 'halo',
  calm: 'calm',
  wrap: 'wrap',
  flame: 'flame',
};

/** The flags the resolution reads (src/diag/flags.ts), plus the effective calm. */
export interface AbFlags {
  /** `?ab=<group>`, trimmed and lower-cased; null when absent. */
  readonly ab: string | null;
  readonly zdiag: ZdiagMode | null;
  readonly nohalo: boolean;
  readonly wrap: SkyWrap | null;
  readonly flame: FlameSway | null;
  /**
   * The effective calm setting: `?calm` laid over the stored calm (src/settings/schema.ts), so
   * `?ab=calm` starts where the session already is. null starts at the first variant.
   */
  readonly calm: number | null;
  readonly bench: string | null;
}

export interface AbActivation {
  readonly group: AbGroupName;
  /** Index into the group's variants (`variants`, else `AB_GROUPS[group]`) of the start variant. */
  readonly start: number;
  /**
   * Set only when the variants differ from `AB_GROUPS[group]`: `?ab=calm` with an effective calm
   * that is not one of its variants inserts it, in descending order (`calmVariants`).
   */
  readonly variants?: readonly string[];
}

export interface AbResolution {
  readonly activation: AbActivation | null;
  /** At most one message; main.ts warns it once. */
  readonly warnings: readonly string[];
}

/** An A/B flag other than `?ab`: the setting it drives, its text and the group it implies. */
interface ImpliedFlag {
  readonly setting: Exclude<AbSetting, 'calm'>;
  readonly text: string;
  readonly variant: string;
  readonly group: AbGroupName;
}

function isGroup(name: string): name is AbGroupName {
  return Object.hasOwn(AB_GROUPS, name);
}

function variantIndex(group: AbGroupName, variant: string): number {
  return (AB_GROUPS[group] as readonly string[]).indexOf(variant);
}

/** The implied flags in precedence order: `?zdiag`, `?nohalo`, `?wrap`, then `?flame`. */
function impliedFlags(flags: AbFlags): ImpliedFlag[] {
  const implied: ImpliedFlag[] = [];
  if (flags.zdiag !== null) {
    implied.push({
      setting: 'zdiag',
      text: `?zdiag=${flags.zdiag}`,
      variant: flags.zdiag,
      group: variantIndex('shimmer', flags.zdiag) >= 0 ? 'shimmer' : 'zdiag-all',
    });
  }
  if (flags.nohalo) {
    implied.push({ setting: 'halo', text: '?nohalo', variant: 'off', group: 'halo' });
  }
  if (flags.wrap !== null) {
    implied.push({
      setting: 'wrap',
      text: `?wrap=${flags.wrap}`,
      variant: flags.wrap,
      group: 'wrap',
    });
  }
  if (flags.flame !== null) {
    implied.push({
      setting: 'flame',
      text: `?flame=${flags.flame}`,
      variant: flags.flame,
      group: 'flame',
    });
  }
  return implied;
}

/**
 * The `calm` group's variants for effective calm `calm`: `AB_GROUPS.calm`, with `calm` inserted in
 * descending order when it is not one of them, so `?ab=calm` starts where the session already is
 * and the boot does not change the calm (F1).
 */
export function calmVariants(calm: number | null): readonly string[] {
  const base: readonly string[] = AB_GROUPS.calm;
  if (calm === null || base.includes(String(calm))) return base;
  return [...base, String(calm)].sort((a, b) => Number(b) - Number(a));
}

/**
 * Whether the boot builds the HUD shown for the A/B group: only for a group `?ab` names. A group
 * an older A/B flag implies (`?zdiag`, `?nohalo`, `?wrap`, `?flame`) leaves it hidden, because those
 * flags drive byte-compared captures.
 */
export function abShowsHudAtBoot(activation: AbActivation | null, ab: string | null): boolean {
  return activation !== null && activation.group === ab;
}

/**
 * Which group starts, and where.
 * - `?ab=<group>` starts that group at its first variant. An unknown group warns and is ignored.
 * - Each other A/B flag implies its group at that flag's variant: `?zdiag=<m>` implies `shimmer`
 *   when m is in it, else `zdiag-all`, `?nohalo` implies `halo` at off, `?wrap=<v>` implies `wrap`
 *   and `?flame=<v>` implies `flame`, each at v. `?calm` is a setting, not an A/B flag, so it
 *   implies nothing, but `?ab=calm` starts at the effective calm (the stored setting, or `?calm`
 *   over it), inserted among the variants when it is not one (`calmVariants`).
 * - The winner is `?ab`, else the first implied flag (`?zdiag`, `?nohalo`, `?wrap`, `?flame`). A flag that drives
 *   the winner's setting at one of its variants sets the start. Any other flag loses: it stays
 *   fixed when the winner drives a different setting, and is ignored when it drives the same one.
 *   Every loss goes into one warning.
 * - The bench ignores all of this.
 */
export function resolveAb(flags: AbFlags): AbResolution {
  if (flags.bench !== null) return { activation: null, warnings: [] };
  const problems: string[] = [];
  let winner: AbGroupName | null = null;
  let winnerText = '';
  if (flags.ab !== null) {
    if (isGroup(flags.ab)) {
      winner = flags.ab;
      winnerText = `?ab=${flags.ab}`;
    } else {
      problems.push(
        `?ab=${flags.ab} is not an A/B group (${Object.keys(AB_GROUPS).join(', ')}); ignoring it`,
      );
    }
  }
  const implied = impliedFlags(flags);
  if (winner === null && implied.length > 0) {
    winner = implied[0].group;
    winnerText = implied[0].text;
  }
  if (winner === null) return { activation: null, warnings: problems };

  let start = 0;
  let started = false;
  let variants: readonly string[] | undefined;
  if (winner === 'calm' && flags.calm !== null) {
    const calm = calmVariants(flags.calm);
    start = calm.indexOf(String(flags.calm));
    if (calm !== AB_GROUPS.calm) variants = calm;
  }
  const losers: string[] = [];
  for (const flag of implied) {
    const index = variantIndex(winner, flag.variant);
    if (flag.setting === OWNS[winner] && index >= 0 && !started) {
      start = index;
      started = true;
    } else if (flag.setting === OWNS[winner]) {
      losers.push(`${flag.text} is ignored`);
    } else {
      losers.push(`${flag.text} stays fixed`);
    }
  }
  if (losers.length > 0) {
    problems.push(`${winnerText} has the A/B button (${winner}); ${losers.join(', ')}`);
  }
  return {
    activation: variants ? { group: winner, start, variants } : { group: winner, start },
    warnings: problems.length > 0 ? [problems.join('. ')] : [],
  };
}

/** One group, as the controller drives it. `apply` must be reversible, with no reload. */
export interface AbGroup {
  readonly name: string;
  readonly variants: readonly string[];
  apply(variant: string): void;
}

export interface AbDiag {
  readonly group: string;
  readonly variants: string[];
  readonly index: number;
  readonly variant: string;
}

export interface AbController {
  /** Moves to the next variant, wrapping round, and applies it. */
  cycle(): void;
  /**
   * Something else (the settings panel's calm) already set `variant`: the index follows it, with
   * no apply. False, and no change, when it is not one of the variants.
   */
  follow(variant: string): boolean;
  /** The HUD line, such as `A/B shimmer: noa2c (3/6)`. */
  label(): string;
  diag(): AbDiag;
}

export function formatAbLine(group: string, variant: string, index: number, count: number): string {
  return `A/B ${group}: ${variant} (${index + 1}/${count})`;
}

/** Applies the start variant at once. */
export function createAbController(group: AbGroup, start: number): AbController {
  const count = group.variants.length;
  let index = Math.min(count - 1, Math.max(0, start));
  group.apply(group.variants[index]);
  return {
    cycle() {
      index = (index + 1) % count;
      group.apply(group.variants[index]);
    },
    follow(variant) {
      const next = group.variants.indexOf(variant);
      if (next < 0) return false;
      index = next;
      return true;
    },
    label: () => formatAbLine(group.name, group.variants[index], index, count),
    diag: () => ({
      group: group.name,
      variants: [...group.variants],
      index,
      variant: group.variants[index],
    }),
  };
}

/** What the groups drive, from main.ts. */
export interface AbGroupDeps {
  /** `?zdiag`'s runtime control (src/render/zdiag.ts). */
  readonly zdiag: {
    setMode(mode: ZdiagMode | null): void;
    /** Precompiles these modes' programs once a stroke batch binds. */
    prepare(modes: readonly (ZdiagMode | null)[]): void;
  };
  /** Shows or hides the halo pass, now or once the world builds. */
  setHalo(on: boolean): void;
  setCalm(calm: number): void;
  /** The sky wrap variant (src/motion/variants.ts). */
  setWrap(wrap: SkyWrap): void;
  /** The cypress sway variant (src/motion/variants.ts). */
  setFlame(sway: FlameSway): void;
}

/**
 * Builds one group's runtime. Called only for the group that resolved, with its activation's
 * `variants` when it carries them.
 */
export function createAbGroup(
  name: AbGroupName,
  deps: AbGroupDeps,
  variants: readonly string[] = AB_GROUPS[name],
): AbGroup {
  if (name === 'shimmer' || name === 'zdiag-all') {
    const modeOf = (variant: string): ZdiagMode | null =>
      variant === 'base' ? null : (variant as ZdiagMode);
    deps.zdiag.prepare(variants.map(modeOf));
    return { name, variants, apply: (variant) => deps.zdiag.setMode(modeOf(variant)) };
  }
  if (name === 'halo') {
    return { name, variants, apply: (variant) => deps.setHalo(variant === 'on') };
  }
  if (name === 'wrap') {
    return { name, variants, apply: (variant) => deps.setWrap(variant as SkyWrap) };
  }
  if (name === 'flame') {
    return { name, variants, apply: (variant) => deps.setFlame(variant as FlameSway) };
  }
  return { name, variants, apply: (variant) => deps.setCalm(Number(variant)) };
}
