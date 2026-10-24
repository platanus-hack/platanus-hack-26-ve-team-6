import { createDatabase } from '@gotchu/database';
import { createFileModelSecretStore } from '@gotchu/backend';
import type { GatewayConfig } from './config.js';
import { startGatewayServer } from './http.js';
import { createGatewayService } from './service.js';

export async function startGateway(config: GatewayConfig) {
  const database = createDatabase({ connectionString: config.databaseUrl, role: 'gotchu_coordinator', max: 4 });
  try {
    await database.checkHealth();
    const service = createGatewayService({ database, capabilityPublicKey: config.capabilityPublicKey,
      ...(config.modelSecretDirectory ? { modelSecrets: createFileModelSecretStore(config.modelSecretDirectory) } : {}) });
    const http = await startGatewayServer({ service, host: config.host, port: config.port, transport: config.transport });
    let closing: Promise<void> | undefined;
    return { service, port: http.port, close: () => {
      closing ??= (async () => { try { await http.close(); } finally { await database.close(); } })();
      return closing;
    } };
  } catch (error) { await database.close(); throw error; }
}
