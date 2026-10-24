import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('survives an expired deadline and an already-created rejection in a real Node child',async()=>{
  const result=await promisify(execFile)(process.execPath,['--unhandled-rejections=strict','--import','tsx',fileURLToPath(new URL('./deadline-child.ts',import.meta.url))],{timeout:5000});
  expect(result.stdout).toContain('deadline-regression-ok');expect(result.stderr).toBe('');
});
