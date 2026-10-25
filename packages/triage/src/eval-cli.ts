import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateCorpus } from './evaluate.js';
const reports = evaluateCorpus();
const serialized = `${JSON.stringify(reports, null, 2)}\n`;
const directory = resolve(import.meta.dirname, '../.local');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'evaluation-report.json'), serialized);
process.stdout.write(serialized);
