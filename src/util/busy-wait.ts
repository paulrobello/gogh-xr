/** Spins the CPU for `ms` (the `?slow` flag). Returns the time actually spent, ms. */
export function busyWait(ms: number, now: () => number = () => performance.now()): number {
  const start = now();
  let t = start;
  while (t - start < ms) t = now();
  return t - start;
}
