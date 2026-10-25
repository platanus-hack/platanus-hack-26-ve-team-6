import { CUSTOMER_MAX_REPORT_BYTES } from '@gotchu/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
export const MAX_REQUEST_BYTES = 12_000_000;
export const MAX_RESPONSE_BYTES = CUSTOMER_MAX_REPORT_BYTES;
/** Response type of a run that streams finished-branch progress lines before its report line. */
export const SCANNER_PROGRESS_TYPE = 'application/x-ndjson';
export function checkSecret(secret: Uint8Array) { if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 1024) throw new Error('Scanner secret must contain 32–1024 bytes'); }
export function signScannerBody(secret: Uint8Array, timestamp: string, rawBody: Uint8Array) {
  checkSecret(secret); return createHmac('sha256',secret).update(`gotchu-scanner-v1\n${timestamp}\n`).update(rawBody).digest('hex');
}
export function verifyScannerSignature(secret: Uint8Array, timestamp: string, signature: string, body: Uint8Array, now = Date.now()) {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(Math.floor(now/1000)-Number(timestamp)) > 60) return false;
  return timingSafeEqual(Buffer.from(signScannerBody(secret,timestamp,body),'hex'),Buffer.from(signature,'hex'));
}
