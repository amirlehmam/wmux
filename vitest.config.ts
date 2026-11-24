import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    // The WSL-folder fast route is opt-in (`wslFastRouteEnabled`, git-view.ts). Its suites test it
    // switched on; tests/unit/wsl-fast-route-switch.test.ts covers the default.
    env: { WMUX_WSL_FAST: '1' },
  },
});
