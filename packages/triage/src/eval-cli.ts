import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateCorpus } from './evaluate.js';
const reports = evaluateCorpus();
const serialized = `${JSON.stringify(reports, null, 2)}\n`;
await writeFile(resolve(import.meta.dirname, '../corpus/evaluation-report.json'), serialized);
process.stdout.write(serialized);
