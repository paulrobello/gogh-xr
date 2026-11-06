import { metaQuest3, XRDevice } from 'iwer';

declare global {
  interface Window {
    __goghIwer?: XRDevice;
  }
}

/**
 * Installs the IWER Quest 3 runtime over navigator.xr. Imported only from the
 * e2e build, so the production bundle never contains IWER.
 */
export function installIwer(): XRDevice {
  const device = new XRDevice(metaQuest3);
  // Chromium exposes a native navigator.xr even with no headset attached.
  device.installRuntime({ forceInstall: true });
  window.__goghIwer = device;
  return device;
}
