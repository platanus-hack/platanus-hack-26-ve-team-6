import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { validationAttestationPayloadSchema, type ValidationAttestationPayload } from '@gotchu/contracts';

export interface ValidatorKey { keyId: string; publicKey: string; privateKey: KeyObject }

export async function loadValidatorKey(path = process.env.GOTCHU_VALIDATOR_KEY_PATH ?? join(homedir(), '.config', 'gotchu', 'validator', 'ed25519.pem')): Promise<ValidatorKey> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let pem: Buffer;
  try { pem = await readFile(path); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    try { await writeFile(path, privatePem, { mode: 0o600, flag: 'wx' }); pem = Buffer.from(privatePem); }
    catch (writeError) {
      if (!(writeError instanceof Error) || !('code' in writeError) || writeError.code !== 'EEXIST') throw writeError;
      pem = await readFile(path);
    }
  }
  await chmod(path, 0o600);
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('validator_key_type_invalid');
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return { keyId: createHash('sha256').update(publicDer).digest('hex'), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

export function signAttestation(payloadInput: ValidationAttestationPayload, key: ValidatorKey) {
  const payload = validationAttestationPayloadSchema.parse(payloadInput);
  const bytes = Buffer.from(JSON.stringify(payload));
  return { payload, keyId: key.keyId, signature: sign(null, bytes, key.privateKey).toString('base64url') };
}

export function verifyAttestation(attestation: { payload: ValidationAttestationPayload; keyId: string; signature: string }, publicKeyPem: string): boolean {
  try {
    const payload = validationAttestationPayloadSchema.parse(attestation.payload);
    const key = createPublicKey(publicKeyPem);
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(attestation.signature, 'base64url'));
  } catch { return false; }
}
