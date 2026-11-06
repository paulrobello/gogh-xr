export type InputCounts = Record<XRHandedness, number>;

export interface InputCounterXr {
  addEventListener(type: 'sessionstart', listener: () => void): void;
  getSession(): XRSession | null;
}

export interface InputCounter {
  readonly selectstart: InputCounts;
}

/** Counts selectstart per handedness across every session the renderer starts. */
export function createInputCounter(xr: InputCounterXr): InputCounter {
  const selectstart: InputCounts = { none: 0, left: 0, right: 0 };
  xr.addEventListener('sessionstart', () => {
    xr.getSession()?.addEventListener('selectstart', (event) => {
      selectstart[event.inputSource.handedness] += 1;
    });
  });
  return { selectstart };
}
