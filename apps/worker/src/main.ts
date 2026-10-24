import { pathToFileURL } from 'node:url';
import { loadWorkerConfig } from './config.js';
import { createWorkerHttpServer, listenWorkerServer } from './http.js';
import { createInvestigationWorkerService } from './worker.js';

export async function startWorker(): Promise<void> {
  const config = await loadWorkerConfig();
  const service = createInvestigationWorkerService({
    capabilityPublicKey: config.capabilityPublicKey,
    ...(config.gatewayBaseUrl ? { gatewayBaseUrl: config.gatewayBaseUrl } : {}),
  });
  const server = createWorkerHttpServer({ config, service });
  await listenWorkerServer(server, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch((error: unknown) => {
    const code = error instanceof Error ? error.name : 'WorkerStartError';
    process.stderr.write(`${code}: worker failed to start\n`);
    process.exitCode = 1;
  });
}
