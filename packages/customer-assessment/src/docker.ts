import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { customerSourceSnapshotSchema, CUSTOMER_MAX_SOURCE_FILE_BYTES, CUSTOMER_MAX_CONTAINER_IMAGE_BYTES, type CustomerRunInput } from '@gotchu/contracts';
import { sha256 } from './common.js';

export const profiles = {
  semgrep: { image:'semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af', version:'1.182.0', config:'semgrep.yaml' },
  gitleaks: { image:'zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854',version:'8.28.0',config:'gitleaks.toml' },
  trivy: { image:'aquasec/trivy@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08',version:'0.67.2',config:null },
} as const;
export type ScannerName = keyof typeof profiles;
export interface TrivyDatabaseProvenance { ociDigest: string; updatedAt: string; databaseSha256: string; javaDatabaseAvailable: false }
export interface ToolResult { output: unknown; image: string; version: string; profileChecksum: string; database?: TrivyDatabaseProvenance }
export interface ScannerAdapter {
  run(name: ScannerName, source: NonNullable<CustomerRunInput['source']>, signal: AbortSignal): Promise<ToolResult>;
  runImage?(image: NonNullable<CustomerRunInput['containerImage']>, signal: AbortSignal): Promise<ToolResult>;
  readiness(): Promise<{ready: boolean; tools: Array<{name: string; available: boolean}>}>;
}
async function command(args: string[], signal: AbortSignal, maxBytes = 1_048_576, allowMissing?: 'container' | 'image') {
  signal.throwIfAborted();
  return new Promise<Buffer>((resolve,reject) => {
    // The trusted host CLI uses only the local daemon; no inherited service credentials or Docker auth config.
    const child = spawn('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',DOCKER_CONFIG:'/nonexistent'},stdio:['ignore','pipe','pipe'],signal});
    const chunks: Buffer[] = []; const errors: Buffer[] = []; let bytes = 0; let exceeded = false;
    child.stdout.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { exceeded = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.stderr.on('data',(chunk: Buffer) => { if(allowMissing && bytes < 65536) errors.push(chunk); bytes += chunk.length; if (bytes > maxBytes) { exceeded = true; child.kill('SIGKILL'); } });
    let processError = false;
    child.on('error',() => { processError=true; child.kill('SIGKILL'); });
    child.on('close',code => {
      const missingResource = allowMissing === 'container' ? 'No such container:' : 'No such image:';
      if (!processError && !exceeded && (code === 0 || allowMissing && Buffer.concat(errors).toString('utf8').includes(missingResource))) resolve(Buffer.concat(chunks));
      else reject(new Error('scanner_failed_or_output_limit'));
    });
  });
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
let verifiedTrivyDatabase: { manifestMtimeMs: number; databaseMtimeMs: number; databaseSize: number; provenance: TrivyDatabaseProvenance } | undefined;
async function trivyDatabase() {
  const directory = process.env.GOTCHU_SCANNER_TRIVY_DB_DIRECTORY;
  if (!directory) return null;
  try {
    const manifestPath = join(directory, 'gotchu-trivy-db.json');
    const dbDirectory = join(directory, 'db');
    const [manifestInfo, directoryInfo, dbInfo] = await Promise.all([lstat(manifestPath), lstat(dbDirectory), lstat(join(dbDirectory, 'trivy.db'))]);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || !dbInfo.isFile() || dbInfo.isSymbolicLink() || dbInfo.size < 1) return null;
    const lockSchema = z.object({
      version: z.literal(1), trivyVersion: z.literal(profiles.trivy.version),
      ociDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), updatedAt: z.iso.datetime(),
      databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict();
    const lock = lockSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    const age = Date.now() - Date.parse(lock.updatedAt);
    if (age < -60 * 60 * 1000 || age > 14 * 24 * 60 * 60 * 1000) return null;
    if (verifiedTrivyDatabase?.manifestMtimeMs === manifestInfo.mtimeMs
      && verifiedTrivyDatabase.databaseMtimeMs === dbInfo.mtimeMs && verifiedTrivyDatabase.databaseSize === dbInfo.size) {
      return verifiedTrivyDatabase.provenance;
    }
    const databaseSha256 = await hashFile(join(dbDirectory, 'trivy.db'));
    if (databaseSha256 !== lock.databaseSha256) return null;
    const provenance = { ociDigest: lock.ociDigest, updatedAt: lock.updatedAt, databaseSha256, javaDatabaseAvailable: false as const };
    verifiedTrivyDatabase = { manifestMtimeMs: manifestInfo.mtimeMs, databaseMtimeMs: dbInfo.mtimeMs, databaseSize: dbInfo.size, provenance };
    return provenance;
  } catch {
    return null;
  }
}

export function createDockerScanners(): ScannerAdapter {
  let cached: {until:number;state:Awaited<ReturnType<ScannerAdapter['readiness']>>} | undefined;
  let pending: ReturnType<ScannerAdapter['readiness']> | undefined;
  let cleanupFault: Error | undefined;
  const adapter: ScannerAdapter = {
    async readiness() {
      if (cleanupFault) throw cleanupFault;
      if(cached && cached.until > Date.now()) return cached.state;
      if(pending) return pending;
      const source = {id:randomUUID(),digest:'0'.repeat(64),revision:'readiness-self-test',files:[
        {path:'probe.ts',content:'export const probe = (input: string) => eval(input);\nconst apiKey = "AKIAQ7XM2V5K8D3P6L9A";'},
        {path:'probe.yaml',content:'apiVersion: v1\nkind: Pod\nmetadata:\n  name: probe\nspec:\n  containers:\n    - name: probe\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n'},
      ]};
      pending = (async()=>{
        const tools: Array<{name:string;available:boolean}> = await Promise.all((Object.keys(profiles) as ScannerName[]).map(async name=>{
          try {
            const result = await adapter.run(name,source,AbortSignal.timeout(35000));
            const object = z.record(z.string(),z.unknown());
            let available = false;
            if(name === 'semgrep') {
              const parsed = z.object({version:z.literal(profiles.semgrep.version),results:z.array(z.object({check_id:z.string()})),errors:z.array(z.unknown())}).parse(result.output);
              available = !parsed.errors.length && parsed.results.some(r=>r.check_id.endsWith('gotchu.javascript.eval'));
            } else if(name === 'gitleaks') available=z.array(z.object({RuleID:z.string()})).parse(result.output).some(r=>r.RuleID==='generic-api-key');
            else available=z.object({Results:z.array(z.object({Misconfigurations:z.array(object).optional()}))}).parse(result.output).Results.some(r=>(r.Misconfigurations?.length??0)>0);
            return {name,available};
          } catch {return {name,available:false};}
        }));
        const db = await trivyDatabase();
        tools.push({ name: 'trivy_image', available: Boolean(db) });
        if (cleanupFault) throw cleanupFault;
        const state={ready:tools.every(t=>t.available),tools};cached={until:Date.now()+30000,state};return state;
      })();
      try{return await pending;}finally{pending=undefined;}
    },
    async run(name,source,parentSignal) {
      if (cleanupFault) throw cleanupFault;
      parentSignal.throwIfAborted();
      customerSourceSnapshotSchema.parse({revision:source.revision,files:source.files});
      const profile = profiles[name]; const id = `gotchu-scan-${randomUUID()}`;
      const directory = await mkdtemp(join(tmpdir(),'gotchu-scanner-'));
      const signal = AbortSignal.any([parentSignal,AbortSignal.timeout(35000)]);
      try {
        const sourceDir = join(directory,'source'); const configDir = join(directory,'profile');
        await mkdir(sourceDir,{mode:0o755}); await mkdir(configDir,{mode:0o755});
        await writeFile(join(configDir,'no-ignore'),'',{mode:0o444});
        if(name==='semgrep') await writeFile(join(sourceDir,'.semgrepignore'),'',{mode:0o444});
        for (const file of source.files) { signal.throwIfAborted(); const path = join(sourceDir,file.path); await mkdir(dirname(path),{recursive:true,mode:0o755}); await writeFile(path,file.content,{flag:'wx',mode:0o444}); }
        const config = profile.config ? await readFile(fileURLToPath(new URL(`../profiles/${profile.config}`,import.meta.url))) : Buffer.from(`trivy-config-iac-builtins:${profile.image}`);
        if (profile.config) await writeFile(join(configDir,profile.config),config,{mode:0o444});
        const args = name === 'semgrep' ? ['semgrep','scan','--oss-only','--config','/profile/semgrep.yaml','--json','--quiet','--metrics','off','--disable-version-check','--no-git-ignore','--disable-nosem','--jobs','1','--timeout','5','--max-memory','384','--max-target-bytes',String(CUSTOMER_MAX_SOURCE_FILE_BYTES),'/source'] : name === 'gitleaks' ? ['dir','/source','--config','/profile/gitleaks.toml','--redact=100','--no-banner','--exit-code','0','--report-format','json','--report-path','/dev/stdout','--max-target-megabytes',String(Math.ceil(CUSTOMER_MAX_SOURCE_FILE_BYTES/1_000_000)),'--ignore-gitleaks-allow','--gitleaks-ignore-path','/profile/no-ignore'] : ['config','--config','/dev/null','--format','json','--quiet','--skip-check-update','--skip-version-check','--misconfig-scanners','kubernetes,terraform,dockerfile','--ignorefile','/profile/no-ignore','--cache-dir','/tmp/trivy','--timeout','25s','/source'];
        await command(['create','--pull','never','--name',id,'--log-driver','none','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--memory-swap','768m','--cpus','1','--ulimit','cpu=30:30','--ulimit','nofile=256:256','--user','65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=134217728,mode=1777','--env','HOME=/tmp','--env','SEMGREP_SEND_METRICS=off','--env','SEMGREP_ENABLE_VERSION_CHECK=0','--workdir','/tmp','--mount',`type=bind,src=${sourceDir},dst=/source,readonly`,'--mount',`type=bind,src=${configDir},dst=/profile,readonly`,profile.image,...args],signal);
        const output = await command(['start','--attach',id],signal);
        const parsed: unknown = JSON.parse(output.toString('utf8'));
        z.union([z.array(z.unknown()),z.record(z.string(),z.unknown())]).parse(parsed);
        return {output:parsed,image:profile.image,version:profile.version,profileChecksum:sha256(config)};
      } catch(error) {
        cached=undefined;
        throw error;
      } finally {
        // Only remove source bytes after the exact container has been confirmed removed.
        // On uncertainty, retain the directory for operator reconciliation and latch the adapter.
        try {
          await command(['rm','--force',id],AbortSignal.timeout(3000),65536,'container');
          await rm(directory,{recursive:true,force:true});
        } catch (cause) {
          cached=undefined;
          cleanupFault=new Error('scanner_cleanup_unavailable',{cause});
          throw cleanupFault;
        }
      }
    },
    async runImage(image,parentSignal) {
      if (cleanupFault) throw cleanupFault;
      parentSignal.throwIfAborted();
      const database = await trivyDatabase();
      if (!database) throw new Error('trivy_vulnerability_database_unavailable');
      const imageArchive = image.kind === 'archive' ? Buffer.from(image.archiveBase64, 'base64') : undefined;
      if (image.kind === 'archive' && (!imageArchive || imageArchive.byteLength !== image.size || imageArchive.byteLength > CUSTOMER_MAX_CONTAINER_IMAGE_BYTES || sha256(imageArchive) !== image.digest)) {
        throw new Error('container_image_archive_digest_mismatch');
      }
      const id = `gotchu-scan-${randomUUID()}`;
      const directory = await mkdtemp(join(tmpdir(),'gotchu-scanner-image-'));
      const signal = AbortSignal.any([parentSignal,AbortSignal.timeout(35000)]);
      let pulledImage = false;
      let preexistingImage = false;
      try {
        let archive: Buffer | undefined = imageArchive;
        if (image.kind === 'registry') {
          const before = await command(['image','inspect',image.reference],signal,65536,'image');
          preexistingImage = before.length > 0;
          pulledImage = !preexistingImage;
          await command(['pull','--platform','linux/amd64',image.reference],signal,65536);
          archive = await command(['image','save',image.reference],signal,CUSTOMER_MAX_CONTAINER_IMAGE_BYTES);
          if (archive.byteLength > CUSTOMER_MAX_CONTAINER_IMAGE_BYTES) throw new Error('container_image_archive_limit');
        }
        const archiveBytes = archive;
        if (!archiveBytes) throw new Error('missing_container_image_archive');
        const archivePath = join(directory,'image.tar');
        const databaseDirectory = join(process.env.GOTCHU_SCANNER_TRIVY_DB_DIRECTORY ?? '', 'db');
        await writeFile(archivePath,archiveBytes,{flag:'wx',mode:0o444});
        const args = ['image','--input','/image.tar','--format','json','--quiet','--skip-db-update','--skip-java-db-update','--skip-check-update','--scanners','vuln','--cache-dir','/tmp','--timeout','25s'];
        // Trivy opens its Bolt database read/write even with updates disabled. The
        // directory is owned by this isolated UID; checksum validation brackets use.
        await command(['create','--pull','never','--name',id,'--log-driver','none','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m','--memory-swap','768m','--cpus','1','--ulimit','cpu=30:30','--ulimit','nofile=256:256','--user','65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=134217728,mode=1777','--env','HOME=/tmp','--workdir','/tmp','--mount',`type=bind,src=${archivePath},dst=/image.tar,readonly`,'--mount',`type=bind,src=${databaseDirectory},dst=/tmp/db`,profiles.trivy.image,...args],signal);
        const output = await command(['start','--attach',id],signal,4_000_000);
        verifiedTrivyDatabase = undefined;
        const databaseAfterScan = await trivyDatabase();
        if (databaseAfterScan?.databaseSha256 !== database.databaseSha256) throw new Error('trivy_vulnerability_database_changed_during_scan');
        const parsed: unknown = JSON.parse(output.toString('utf8'));
        z.record(z.string(),z.unknown()).parse(parsed);
        const config = await readFile(fileURLToPath(new URL('../profiles/trivy-image-profile.json', import.meta.url)));
        return {output:parsed,image:profiles.trivy.image,version:profiles.trivy.version,profileChecksum:sha256(config),database};
      } catch(error) {
        cached=undefined;
        throw error;
      } finally {
        try {
          await command(['rm','--force',id],AbortSignal.timeout(3000),65536,'container');
          await rm(directory,{recursive:true,force:true});
          if (pulledImage && image.kind === 'registry') await command(['image','rm','--no-prune',image.reference],AbortSignal.timeout(5000),65536,'image');
        } catch (cause) {
          cached=undefined;
          cleanupFault=new Error('scanner_cleanup_unavailable',{cause});
          throw cleanupFault;
        }
      }
    },
  };
  return adapter;
}
