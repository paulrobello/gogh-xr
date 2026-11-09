import { execFileSync } from 'node:child_process';
import { DEV_PORT as PORT } from './ports.ts';

function listeners(): number[] {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Only a vite process (vite run directly, or by bun or node) is ours to stop. */
export function isViteCommand(command: string): boolean {
  return /(^|[\s/])vite(\.js)?(\s|$)/.test(command) || /node_modules\/vite\//.test(command);
}

if (import.meta.main) {
  const pids = listeners();
  const foreign = pids.filter((pid) => !isViteCommand(commandOf(pid)));
  if (foreign.length) {
    for (const pid of foreign)
      console.error(`Port ${PORT} is held by pid ${pid}: ${commandOf(pid)}`);
    console.error('Not a vite process, so dev-stop will not kill it.');
    process.exit(1);
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (listeners().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of listeners()) process.kill(pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (listeners().length) throw new Error(`Port ${PORT} did not become free`);
  console.log(
    pids.length ? `Stopped; port ${PORT} is free.` : `Nothing listening on port ${PORT}.`,
  );
}
