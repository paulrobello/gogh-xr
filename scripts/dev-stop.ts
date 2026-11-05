import { execFileSync } from 'node:child_process';

const PORT = 4252;

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

const pids = listeners();
for (const pid of pids) process.kill(pid, 'SIGTERM');
const deadline = Date.now() + 2000;
while (listeners().length && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
for (const pid of listeners()) process.kill(pid, 'SIGKILL');
await new Promise((resolve) => setTimeout(resolve, 200));
if (listeners().length) throw new Error(`Port ${PORT} did not become free`);
console.log(pids.length ? `Stopped; port ${PORT} is free.` : `Nothing listening on port ${PORT}.`);
