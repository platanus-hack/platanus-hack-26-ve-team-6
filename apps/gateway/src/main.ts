import { loadGatewayConfig } from './config.js';
import { startGateway } from './runtime.js';

try {
  const config = await loadGatewayConfig();
  const gateway = await startGateway(config);
  process.stdout.write(`Gateway listening on ${config.host}:${gateway.port} (${config.transport.mode}).\n`);
  const stop = () => { gateway.close().catch(() => { process.stderr.write('Gateway shutdown failed.\n'); process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  // Configuration/PG exceptions can contain credentials; do not log their text.
  process.stderr.write('Gateway startup failed; check runtime login, public key, TLS, and migrations.\n');
  process.exitCode = 1;
}
