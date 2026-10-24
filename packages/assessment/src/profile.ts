import { isIP } from 'node:net';
import { z } from 'zod';

export const controlledTargetKey = 'controlled-demo-store';
export const controlledSourceFileSchema = z.enum(['store.ts', 'settings.json', 'package.json']);
export type ControlledSourceFile = z.infer<typeof controlledSourceFileSchema>;
export const MAX_FILE_BYTES = 16_384;
export const FILE_TIMEOUT_MS = 2_000;
export const internalTool = { name: 'gotchu-controlled-static-profile', version: '1.0.0' };
export const externalTool = { name: 'gotchu-controlled-http-profile', version: '1.0.0' };

export const controlledTransportOptionsSchema = z.object({
  origin: z.string().max(200).default('http://127.0.0.1:4100').refine((value) => {
    // Validate the spelling before URL parsing: URL normalizes integer, hex and shortened IPs.
    const match = /^http:\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)(?::([0-9]+))?$/.exec(value);
    if (!match?.[1] || isIP(match[1]) !== 4) return false;
    const [a, b] = match[1].split('.').map(Number);
    const port = Number(match[2] ?? '80');
    return port >= 1 && port <= 65_535 && (a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b !== undefined && b >= 16 && b <= 31);
  }, 'Use an HTTP origin with a literal loopback/RFC1918 IPv4 address and no credentials, path, query or fragment'),
  timeoutMs: z.number().int().min(1).max(2_000).default(2_000),
  maxBodyBytes: z.number().int().min(1).max(2_048).default(2_048),
}).strict();
export type ControlledTransportOptions = z.infer<typeof controlledTransportOptionsSchema>;

export class InspectionUnavailable extends Error {}

export async function withDeadline<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new InspectionUnavailable('Read deadline exceeded')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
