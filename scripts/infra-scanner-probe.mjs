import { readFile } from 'node:fs/promises';
import { get } from 'node:https';

export async function runScannerProbe({
  origin = process.env.GOTCHU_SCANNER_ORIGIN,
  caFile = process.env.GOTCHU_SCANNER_CA_FILE,
  timeoutMs = 5_000,
} = {}) {
  if (!origin || !caFile) throw new Error('scanner_probe_configuration_invalid');
  const ca = await readFile(caFile);
  const url = new URL('/readyz', origin);

  await new Promise((resolve, reject) => {
    const request = get(url, { ca, timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16_384) request.destroy(new Error('scanner_response_too_large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch { reject(new Error('scanner_response_invalid')); return; }
        if (response.statusCode !== 200 || payload?.ready !== true) {
          reject(new Error('scanner_not_ready'));
          return;
        }
        resolve();
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('scanner_probe_timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
  });
}

if (process.env.GOTCHU_SCANNER_PROBE_INLINE === '1') {
  try {
    await runScannerProbe();
    process.stdout.write('scanner_ready\n');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error ? error.message : 'unknown';
    process.stderr.write(`scanner_probe_failed:${code}\n`);
    process.exitCode = 1;
  }
}
