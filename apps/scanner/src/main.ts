import { createCustomerAssessmentRunner, createNpmLicenseAdapter, createOsvAdapter } from '@gotchu/customer-assessment';
import { loadScannerRuntimeConfig } from './runtime-config.js';
import { createScannerServer } from './server.js';

async function main() {
  const config = await loadScannerRuntimeConfig();
  const runner = createCustomerAssessmentRunner({ licenses: createNpmLicenseAdapter(), ...(config.osvEnabled ? { advisory: createOsvAdapter() } : {}) });
  const server = createScannerServer({
    secret: config.secret,
    ...(config.tls ? { tls: config.tls } : {}),
    runner,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  console.log(JSON.stringify({ event: 'scanner_started', host: config.host, port: config.port, tls: Boolean(config.tls) }));
  void runner.readiness().then(
    (state) => console.log(JSON.stringify({ event: 'scanner_readiness_checked', ...state })),
    (error: unknown) => console.error(JSON.stringify({ event: 'scanner_readiness_failed', type: error instanceof Error ? error.name : 'unknown' })),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'scanner_start_failed', type: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
});
