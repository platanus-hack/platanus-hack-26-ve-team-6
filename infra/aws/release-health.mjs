import { readFile } from 'node:fs/promises';
import { get } from 'node:https';

const deadline = Date.now() + 180_000;
async function probe(port, path, certificate) {
  const ca = await readFile(certificate);
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path, ca, timeout: 10000 }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) request.destroy(new Error('Readiness response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(response.statusCode === 200 && (result.ready === true || result.status === 'ready'));
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Readiness timeout')));
    request.on('error', reject);
  });
}
for (;;) {
  try {
    if (await probe(4400, '/readyz', '/etc/gotchu/scanner.crt') &&
        await probe(3000, '/api/ready', '/etc/gotchu/web.crt')) break;
  } catch { /* Services may still be starting; keep the retry bounded. */ }
  if (Date.now() >= deadline) throw new Error('Release readiness failed');
  await new Promise(resolve => setTimeout(resolve, 2000));
}
const coordinator = await fetch('http://127.0.0.1:3003/health/ready', { signal: AbortSignal.timeout(10000) });
const status = await coordinator.json();
if (!coordinator.ok || (status.ready !== true && status.status !== 'ready')) throw new Error('Coordinator is not ready');
