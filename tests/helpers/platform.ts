/** Run `fn` with `process.platform` reading as `platform`, and put the real value back, however `fn` ends. */
export function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}
