/**
 * The time the reactive tracker differentiates hand positions against. A headset predicts the
 * controller poses for the frame's `predictedDisplayTime`, which can diverge from the callback
 * time during frame drops, so velocities taken against the callback time jitter. IWER makes the
 * two equal. A missing, non-finite, zero or negative prediction falls back to the callback time.
 *
 * The `trackertime` A/B group (src/diag/ab.ts) switches the source live: `predicted` is the
 * shipped behaviour, `callback` always takes the callback time.
 */
export const TRACKER_TIME_SOURCES = ['predicted', 'callback'] as const;
export type TrackerTimeSource = (typeof TRACKER_TIME_SOURCES)[number];

let source: TrackerTimeSource = 'predicted';

export function setTrackerTimeSource(next: TrackerTimeSource): void {
  source = next;
}

export function trackerTimeSource(): TrackerTimeSource {
  return source;
}

export function trackerTime(
  callbackTime: number,
  frame?: { predictedDisplayTime?: number } | null,
): number {
  if (source === 'callback') return callbackTime;
  const predicted = frame?.predictedDisplayTime;
  return typeof predicted === 'number' && Number.isFinite(predicted) && predicted > 0
    ? predicted
    : callbackTime;
}
