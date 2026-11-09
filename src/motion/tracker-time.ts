/**
 * The time the reactive tracker differentiates hand positions against. A headset predicts the
 * controller poses for the frame's `predictedDisplayTime`, which can diverge from the callback
 * time during frame drops, so velocities taken against the callback time jitter. IWER makes the
 * two equal. A missing, non-finite, zero or negative prediction falls back to the callback time.
 */
export function trackerTime(
  callbackTime: number,
  frame?: { predictedDisplayTime?: number } | null,
): number {
  const predicted = frame?.predictedDisplayTime;
  return typeof predicted === 'number' && Number.isFinite(predicted) && predicted > 0
    ? predicted
    : callbackTime;
}
