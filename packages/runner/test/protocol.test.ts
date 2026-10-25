import { describe, expect, it } from 'vitest';
import { GuestProtocolError, parseGuestFrame } from '../src/protocol.js';

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`GOTCHU_RESULT_V1 ${payload.length}\n`), payload]);
}

const emptyGuestOutput = { stdout: '', stderr: '', artifacts: [] };
const emptyDependencyEvidence = { lockfileSha256: '0'.repeat(64), tarballSetSha256: '0'.repeat(64) };

describe('guest result parsing', () => {
  it('parses a length-prefixed guest result', () => {
    expect(parseGuestFrame(Buffer.concat([Buffer.from('kernel log\n'), frame({ status: 'completed', exitCode: 0, ...emptyGuestOutput, ...emptyDependencyEvidence })]))).toMatchObject({ status: 'completed', exitCode: 0 });
  });

  it('rejects malformed, duplicate, oversized, and forged guest frames', () => {
    expect(() => parseGuestFrame(Buffer.from('not a frame'))).toThrow(GuestProtocolError);
    const valid = frame({ status: 'completed', exitCode: 0, ...emptyGuestOutput, ...emptyDependencyEvidence });
    expect(() => parseGuestFrame(Buffer.concat([valid, Buffer.from('\n'), valid]))).toThrow(/exactly one/);
    expect(() => parseGuestFrame(Buffer.from('GOTCHU_RESULT_V1 99999999\n{}'))).toThrow(/length/);
    expect(() => parseGuestFrame(frame({ status: 'validated', success: true }))).toThrow(/schema/);
  });

});
