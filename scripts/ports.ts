/** The one source for the dev and e2e-preview ports: vite.config.ts, dev-stop and the e2e config read these. */
export const DEV_PORT = 4252;

/** Parallel worktrees collide on the reserved port; override with E2E_PORT=NNNN make e2e. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4253);
