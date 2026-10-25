import { createDatabase } from '@gotchu/database';
import { createFileModelSecretStore, createModelEndpointValidator } from '@gotchu/backend';
import type { GatewayConfig } from './config.js';
import { startGatewayServer } from './http.js';
import { createModelPort } from './model-provider.js';
import { createGatewayService } from './service.js';
import { cleanupStaleSubscriptionCliScratchDirectories } from './subscription-cli.js';

export async function startGateway(config: GatewayConfig) {
  await cleanupStaleSubscriptionCliScratchDirectories();
  const database = createDatabase({ connectionString: config.databaseUrl, role: 'gotchu_coordinator', max: 4 });
  try {
    await database.checkHealth();
    const service = createGatewayService({ database, capabilityPublicKey: config.capabilityPublicKey,
      ...(config.modelProbeSecret ? { modelProbeSecret: config.modelProbeSecret } : {}),
      modelEndpointValidator: createModelEndpointValidator({ allowSelfHostedEndpoints: config.allowSelfHostedModelEndpoints }),
      modelPort: createModelPort({ cli: {
        ...(config.claudeCodeBinary ? { claudeCodeBinary: config.claudeCodeBinary } : {}),
        ...(config.codexBinary ? { codexBinary: config.codexBinary } : {}),
      } }),
      ...(config.modelSecretDirectory ? { modelSecrets: createFileModelSecretStore(config.modelSecretDirectory) } : {}) });
    const http = await startGatewayServer({ service, host: config.host, port: config.port, transport: config.transport });
    let closing: Promise<void> | undefined;
    return { service, port: http.port, close: () => {
      closing ??= (async () => { try { await http.close(); } finally { await database.close(); } })();
      return closing;
    } };
  } catch (error) { await database.close(); throw error; }
}
