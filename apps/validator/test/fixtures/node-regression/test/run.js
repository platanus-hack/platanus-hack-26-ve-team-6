const fs = require('node:fs');
const path = require('node:path');
const { isAuthorized } = require('../src/feature');

let passed = 0;
let failed = 0;
try {
  if (isAuthorized() !== true) throw new Error('authorization behavior regressed');
  passed += 1;
} catch {
  failed += 1;
}
fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'test-results', 'evidence.json'), JSON.stringify({ passed, failed, skipped: 0, regression: failed > 0 ? 'failed_for_target' : 'passed' }));
if (failed > 0) process.exitCode = 1;
