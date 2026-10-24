import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createDockerScanners } from '../src/docker.js';
import { input } from './fixtures.js';

vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:vi.fn()}));
afterEach(()=>vi.resetAllMocks());

it('latches cleanup uncertainty and preserves its directory for operator reconciliation',async()=>{
  const source=input().source;if(!source)throw new Error('missing_source');
  let directory:string|undefined;
  vi.mocked(spawn).mockImplementation((_command,args)=>{
    const child=Object.assign(new ChildProcess(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    const mount=args?.find(arg=>arg.startsWith('type=bind,src=') && arg.includes('dst=/source'));
    if(mount)directory=dirname(mount.split(',')[1]!.slice('src='.length));
    queueMicrotask(()=>{child.stdout.write('{}');child.emit('close',args?.includes('rm')?1:0);});
    return child;
  });
  const adapter=createDockerScanners();
  try {
    await expect(adapter.run('gitleaks',source,AbortSignal.timeout(1000))).rejects.toThrow('scanner_cleanup_unavailable');
    const calls=vi.mocked(spawn).mock.calls.length;
    await expect(adapter.readiness()).rejects.toThrow('scanner_cleanup_unavailable');
    await expect(adapter.run('gitleaks',source,AbortSignal.timeout(1000))).rejects.toThrow('scanner_cleanup_unavailable');
    expect(spawn).toHaveBeenCalledTimes(calls);
    if(!directory)throw new Error('missing_directory');await expect(access(directory)).resolves.toBeUndefined();
  } finally {if(directory)await rm(directory,{recursive:true,force:true});}
});

it('removes anonymous volumes attached to the exact scanner container',async()=>{
  const source=input().source;if(!source)throw new Error('missing_source');
  vi.mocked(spawn).mockImplementation((_command,args)=>{
    const child=Object.assign(new ChildProcess(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    queueMicrotask(()=>{if(args?.includes('start'))child.stdout.write('[]');child.emit('close',0);});
    return child;
  });
  await createDockerScanners().run('gitleaks',source,AbortSignal.timeout(1000));
  const cleanup=vi.mocked(spawn).mock.calls.map(([,args])=>args).find(args=>args.includes('rm'));
  const removeIndex=cleanup?.indexOf('rm')??-1;
  expect(cleanup?.slice(removeIndex,removeIndex+3)).toEqual(['rm','--force','--volumes']);
  expect(cleanup?.[removeIndex+3]).toMatch(/^gotchu-scan-/);
});

it('waits for an aborted Docker CLI to close before issuing removal',async()=>{
  const source=input().source;if(!source)throw new Error('missing_source');
  let abortedChild:EventEmitter|undefined;let removeStarted=false;
  vi.mocked(spawn).mockImplementation((_command,args)=>{
    const child=Object.assign(new ChildProcess(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    if(args?.includes('start')){abortedChild=child;queueMicrotask(()=>child.emit('error',new Error('AbortError')));}
    else {if(args?.includes('rm'))removeStarted=true;queueMicrotask(()=>{child.stdout.write('{}');child.emit('close',0);});}
    return child;
  });
  const work=createDockerScanners().run('gitleaks',source,AbortSignal.timeout(1000));
  const result=expect(work).rejects.toThrow('scanner_failed_or_output_limit');
  await vi.waitFor(()=>expect(abortedChild).toBeDefined());expect(removeStarted).toBe(false);
  abortedChild?.emit('close',1);await result;expect(removeStarted).toBe(true);
});
