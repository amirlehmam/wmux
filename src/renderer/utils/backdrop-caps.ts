/**
 * What this host can actually do about window transparency, fetched once.
 *
 * The answer is a Windows build-number check in main, fixed for the lifetime of
 * the process. Three call sites were each fetching it over IPC and each writing
 * their own fallback — `caps?.transparency === true` in one place, a `useState`
 * default in another, an `any` cast in a third — which is three chances for
 * them to disagree about a value that cannot change.
 *
 * Two separate capabilities, deliberately: plain alpha needs only DWM and so
 * reaches Windows 10, while the blur materials need Win11.
 */
export interface BackdropCaps {
  transparency: boolean;
  materials: boolean;
}

export const NO_BACKDROP: BackdropCaps = { transparency: false, materials: false };

let cached: Promise<BackdropCaps> | null = null;

export function backdropCaps(): Promise<BackdropCaps> {
  if (!cached) {
    cached = Promise.resolve(window.wmux?.window?.supportsBackdrop?.())
      .then((caps) => ({
        transparency: caps?.transparency === true,
        materials: caps?.materials === true,
      }))
      .catch(() => {
        // Not cached as a permanent "no": a failure here is the IPC being
        // unavailable, not the host lacking the capability, and answering
        // "unsupported" forever would hide transparency for the whole session.
        cached = null;
        return NO_BACKDROP;
      });
  }
  return cached;
}
