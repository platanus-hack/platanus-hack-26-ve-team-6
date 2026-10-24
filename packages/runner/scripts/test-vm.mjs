import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { accessSync } from 'node:fs';

try {
  accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
} catch {
  console.error('Real VM tests require read/write access to /dev/kvm. Run under the kvm group.');
  process.exit(2);
}

const result = spawnSync('vitest', ['run', 'test/runner.vm.test.ts', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
