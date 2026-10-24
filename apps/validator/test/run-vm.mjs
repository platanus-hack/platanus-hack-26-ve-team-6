import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFirecrackerRunner, checkRunnerGate, runnerJobSchema, runnerResultSchema } from '@gotchu/runner';
import { sourceArchive } from '../dist/archive.js';
import { runValidatedRunnerJob } from '../dist/validator.js';
import { suiteModifiedByCandidate, validationAdmissionReason } from '../dist/validation-rules.js';

if (process.env.GOTCHU_TEST_VM !== '1') {
  console.log('VM suite skipped; set GOTCHU_TEST_VM=1 to run real Firecracker jobs.');
  process.exit(0);
}
const gate = await checkRunnerGate();
if (gate.status !== 'open') throw new Error(`Runner gate is closed: ${gate.reason}`);
const root = fileURLToPath(new URL('./fixtures/node-regression/', import.meta.url));
async function source() {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else files.push({ path: relative(root, target), content: await readFile(target, 'utf8') });
    }
  }
  await walk(root);
  return files;
}
const baseFiles = await source();
const files = new Map(baseFiles.map(file => [file.path, file.content]));
files.set('src/feature.js', 'exports.isAuthorized = () => true;\n');
const baseSnapshot = { revision: 'fixture-base', files: baseFiles };
function changedSnapshot(path, content) { const changed = new Map(baseFiles.map(file => [file.path, file.content])); changed.set(path, content); return { revision: 'fixture-candidate', files: [...changed].map(([path, content]) => ({ path, content })) }; }
function withFile(path, content) { const changed = new Map(baseFiles.map(file => [file.path, file.content])); changed.set(path, content); return [...changed].map(([path, content]) => ({ path, content })); }
const runner = createFirecrackerRunner({ maxConcurrent: 1, resolveInput: async (_reference, scope) => inputs.get(`${scope.organizationId}:${_reference.objectId}`) });
const inputs = new Map();
async function run(filesForRun) {
  const bytes = sourceArchive({ revision: 'validator-vm-fixture', files: filesForRun }).bytes;
  const objectId = randomUUID(); const organizationId = randomUUID(); const jobId = randomUUID();
  inputs.set(`${organizationId}:${objectId}`, bytes);
  try {
    return runnerResultSchema.parse(await runner.runJob(runnerJobSchema.parse({ jobId, organizationId, profile: 'node24-npm-test', input: { objectId, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }, limits: { vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120_000, outputBytes: 262_144, diskMiB: 2048 }, networkPolicy: { mode: 'deny' } })));
  } finally { inputs.delete(`${organizationId}:${objectId}`); }
}
const base = await run(baseFiles);
if (base.status !== 'completed' || base.exitCode === 0 || !base.isolation.cleanupVerified) throw new Error(`Base fixture did not reproduce in VM: ${base.status}`);
const baseEvidence = base.artifacts.find(artifact => artifact.path === 'test-results/evidence.json');
if (!baseEvidence || JSON.parse(Buffer.from(baseEvidence.contentBase64, 'base64').toString('utf8')).regression !== 'failed_for_target') throw new Error('Base regression fixture did not identify the target failure');
const result = await run([...files].map(([path, content]) => ({ path, content })));
if (result.status !== 'completed' || result.exitCode !== 0 || !result.isolation.cleanupVerified) throw new Error(`Corrected fixture did not pass in VM: ${result.status}`);
const evidence = result.artifacts.find(artifact => artifact.path === 'test-results/evidence.json');
if (!evidence || JSON.parse(Buffer.from(evidence.contentBase64, 'base64').toString('utf8')).passed !== 1) throw new Error('Expected one passing functional fixture test artifact');
files.delete('src/feature.js');
const deleted = await run([...files].map(([path, content]) => ({ path, content })));
if (deleted.status !== 'completed' || deleted.exitCode === 0 || !deleted.isolation.cleanupVerified) throw new Error(`Function deletion was not caught by the VM suite: ${deleted.status}`);
const failing = await run(withFile('test/run.js', "const fs=require('node:fs');fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/evidence.json',JSON.stringify({passed:0,failed:1,skipped:0,regression:'failed_for_target'}));process.exitCode=1;"));
if (failing.status !== 'completed' || failing.exitCode === 0 || !failing.isolation.cleanupVerified) throw new Error(`Failing suite did not fail in VM: ${failing.status}`);
const skipped = await run(withFile('test/run.js', "const fs=require('node:fs');fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/evidence.json',JSON.stringify({passed:0,failed:0,skipped:1,regression:'passed'}));"));
const skippedArtifact = skipped.artifacts.find(artifact => artifact.path === 'test-results/evidence.json');
if (skipped.status !== 'completed' || skipped.exitCode !== 0 || !skippedArtifact || JSON.parse(Buffer.from(skippedArtifact.contentBase64, 'base64').toString('utf8')).skipped !== 1) throw new Error(`Dynamically skipped suite was not captured in VM: ${skipped.status}`);
const suiteConfigEdit = changedSnapshot('vitest.config.ts', 'export default { test: { include: [] } };');
if (!suiteModifiedByCandidate(baseSnapshot, suiteConfigEdit, { scriptName: 'test', regressionTestPath: 'test/run.js' })) throw new Error('Candidate test config edit was not classified suite_modified_by_candidate');
if (validationAdmissionReason({ suiteConfigured: true, baseDigestMatches: false, candidateDigestMatches: true, scriptName: 'test', gateOpen: true }) !== 'approved_base_digest_mismatch') throw new Error('Mismatched approved base was not refused');
if (validationAdmissionReason({ suiteConfigured: true, baseDigestMatches: true, candidateDigestMatches: true, scriptName: 'test', gateOpen: false }) !== 'runner_gate_closed') throw new Error('Closed runner gate was not inconclusive');
let injected = false;
try {
  await runValidatedRunnerJob(async () => { injected = true; return { status: 'completed', exitCode: 0, isolation: { cleanupVerified: true } }; }, {});
  throw new Error('Malformed runner frame was accepted');
} catch (error) {
  if (!injected || error.message !== 'validation_runner_frame_invalid') throw error;
}
console.log('Live VM evidence: base reproduction, corrected candidate, deleted functionality, failing suite, dynamically skipped suite, config-tamper refusal, base-digest refusal, closed-gate inconclusive, and malformed fixture runner frame inconclusive.');
