import { startDemoTargetServer } from './index.js';

const target = await startDemoTargetServer({
  ...(process.env.GOTCHU_DEMO_HOST === undefined ? {} : { host: process.env.GOTCHU_DEMO_HOST }),
  ...(process.env.GOTCHU_DEMO_PORT === undefined ? {} : { port: Number(process.env.GOTCHU_DEMO_PORT) }),
});
process.stdout.write(`Controlled fictional store: ${target.origin} (PID ${process.pid})\n`);

let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  target.close().catch((error: unknown) => {
    process.stderr.write(`Demo shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
