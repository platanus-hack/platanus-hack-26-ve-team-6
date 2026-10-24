#!/usr/bin/env node
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { link, open, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const magic = Buffer.from('GOTCHUB1');
const saltSize = 16;
const nonceSize = 12;
const tagSize = 16;
const headerSize = magic.length + saltSize + nonceSize + tagSize;
const keySize = 32;
const kdf = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function passphraseFromStdin() {
  const passphrase = readFileSync(0).toString('utf8').replace(/\r?\n$/, '');
  if (Buffer.byteLength(passphrase) < 16 || Buffer.byteLength(passphrase) > 1024) throw new Error('invalid_passphrase_length');
  return passphrase;
}

async function encrypt(input, output, passphrase) {
  const salt = randomBytes(saltSize);
  const nonce = randomBytes(nonceSize);
  const cipherPath = `${output}.ciphertext-${process.pid}-${randomBytes(6).toString('hex')}`;
  const encryptedPath = `${output}.encrypted-${process.pid}-${randomBytes(6).toString('hex')}`;
  const key = scryptSync(passphrase, salt, keySize, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  try {
    await pipeline(createReadStream(input), cipher, createWriteStream(cipherPath, { flags: 'wx', mode: 0o600 }));
    const header = Buffer.concat([magic, salt, nonce, cipher.getAuthTag()]);
    async function* chunks() {
      yield header;
      for await (const chunk of createReadStream(cipherPath)) yield chunk;
    }
    await pipeline(Readable.from(chunks()), createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 }));
    await link(encryptedPath, output);
  } catch (error) {
    throw error;
  } finally {
    key.fill(0);
    await Promise.all([rm(cipherPath, { force: true }), rm(encryptedPath, { force: true })]);
  }
}

async function decrypt(input, output, passphrase) {
  const size = (await stat(input)).size;
  if (size < headerSize) throw new Error('invalid_backup');
  const handle = await open(input, 'r');
  const header = Buffer.alloc(headerSize);
  try {
    const { bytesRead } = await handle.read(header, 0, headerSize, 0);
    if (bytesRead !== headerSize || !header.subarray(0, magic.length).equals(magic)) throw new Error('invalid_backup');
  } finally { await handle.close(); }

  const saltStart = magic.length;
  const nonceStart = saltStart + saltSize;
  const tagStart = nonceStart + nonceSize;
  const plaintextPath = `${output}.plaintext-${process.pid}-${randomBytes(6).toString('hex')}`;
  const key = scryptSync(passphrase, header.subarray(saltStart, nonceStart), keySize, kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(nonceStart, tagStart));
  decipher.setAuthTag(header.subarray(tagStart, headerSize));
  try {
    const ciphertext = size === headerSize ? Readable.from([]) : createReadStream(input, { start: headerSize });
    await pipeline(ciphertext, decipher, createWriteStream(plaintextPath, { flags: 'wx', mode: 0o600 }));
    await link(plaintextPath, output);
  } catch (error) {
    throw error;
  } finally {
    key.fill(0);
    await rm(plaintextPath, { force: true });
  }
}

const [operation, input, output] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(operation) || !input || !output || resolve(input) === resolve(output)) {
  process.stderr.write(`Usage: ${basename(process.argv[1] ?? 'gotchu-backup-crypto.mjs')} encrypt|decrypt <input> <output>\n`);
  process.exit(2);
}

try {
  const passphrase = await passphraseFromStdin();
  if (operation === 'encrypt') await encrypt(input, output, passphrase);
  else await decrypt(input, output, passphrase);
} catch {
  process.stderr.write(operation === 'decrypt' ? 'El respaldo o la frase de paso no son válidos.\n' : 'No se pudo cifrar el respaldo.\n');
  process.exitCode = 1;
}
