import { createHash } from 'node:crypto';
import { z } from 'zod';
import { runnerResultSchema, type RunnerResult } from './contracts.js';

export const FRAME_PREFIX = 'GOTCHU_RESULT_V1 ';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class GuestProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestProtocolError';
  }
}

const guestOutputFields = {
  stdout: z.string().max(1024 * 1024),
  stderr: z.string().max(1024 * 1024),
  artifacts: z.array(z.unknown()).max(1000),
};
const guestPayloadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), exitCode: z.number().int(), ...guestOutputFields }).strict(),
  z.object({ status: z.literal('timed_out'), ...guestOutputFields }).strict(),
  z.object({
    status: z.literal('resource_exceeded'),
    exitCode: z.number().int(),
    resource: z.enum(['pids', 'memory', 'disk', 'output', 'cpu']),
    ...guestOutputFields,
  }).strict(),
  z.object({ status: z.literal('infrastructure_failed'), reason: z.string().min(1).max(512) }).strict(),
]);

export type GuestPayload = z.infer<typeof guestPayloadSchema>;

export interface CapturedOutput {
  readonly text: string;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

export function makeOutput(value: string, limitBytes: number): CapturedOutput {
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.min(bytes.length, limitBytes);
  let text = '';
  let safeBytes = Buffer.alloc(0);
  do {
    text = bytes.subarray(0, end).toString('utf8');
    safeBytes = Buffer.from(text, 'utf8');
    if (safeBytes.length <= limitBytes) break;
    end -= 1;
  } while (end >= 0);
  return {
    text,
    sha256: createHash('sha256').update(safeBytes).digest('hex'),
    truncated: bytes.length > safeBytes.length,
    bytes: safeBytes.length,
  };
}

export function parseGuestFrame(serial: Uint8Array): GuestPayload {
  const text = Buffer.from(serial).toString('utf8');
  const matches = [...text.matchAll(/(?:^|\n)GOTCHU_RESULT_V1 ([0-9]{1,8})\r?\n/g)];
  if (matches.length !== 1) throw new GuestProtocolError('Guest output must contain exactly one result frame');
  const match = matches[0];
  if (!match) throw new GuestProtocolError('Guest result frame is missing');
  const frameLength = Number(match[1]);
  if (!Number.isSafeInteger(frameLength) || frameLength < 2 || frameLength > MAX_FRAME_BYTES) {
    throw new GuestProtocolError('Guest result frame length is invalid');
  }
  const jsonStart = match.index + match[0].length;
  const jsonByteStart = Buffer.byteLength(text.slice(0, jsonStart), 'utf8');
  const frame = Buffer.from(serial).subarray(jsonByteStart, jsonByteStart + frameLength);
  if (frame.length !== frameLength) throw new GuestProtocolError('Guest result frame is truncated');
  let payload: unknown;
  try {
    payload = JSON.parse(frame.toString('utf8'));
  } catch {
    throw new GuestProtocolError('Guest result frame is not valid JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GuestProtocolError('Guest result payload must be an object');
  }
  const result = guestPayloadSchema.safeParse(payload);
  if (!result.success) throw new GuestProtocolError('Guest result payload failed schema validation');
  return result.data;
}

export function validateGuestPayload(payload: GuestPayload): GuestPayload {
  return guestPayloadSchema.parse(payload);
}

export function validateHostResult(payload: unknown): RunnerResult {
  return runnerResultSchema.parse(payload);
}
