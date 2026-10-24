import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonitoringRepositoryCatalog } from '../src/config.js';
import { createLocalGitRepositoryReader } from '../src/local-git.js';

const directories: string[] = [];
async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-monitor-git-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function git(args: string[], cwd?: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
}

async function repositoryFixture(root: string) {
  const managed = join(root, 'managed');
  const bare = join(managed, 'acme', 'product.git');
  const working = join(root, 'working-copy');
  await mkdir(join(managed, 'acme'), { recursive: true });
  git(['init', '--bare', '--initial-branch=main', bare]);
  git(['init', '--initial-branch=main', working]);
  await writeFile(join(working, 'src.ts'), 'export const value = 1;\n');
  git(['add', 'src.ts'], working);
  git(['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline'], working);
  git(['push', bare, 'HEAD:refs/heads/main'], working);
  return { managed, bare, working };
}

function scopedCatalog(repositoryRoot: string, path = 'acme/product.git') {
  const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
  return {
    scope,
    catalog: createMonitoringRepositoryCatalog({
      repositoryRoot,
      repositories: [{ ...scope, repositoryKey: 'customer-product', displayName: 'Customer product', provider: 'local_git', path, ref: 'refs/heads/main' }],
    }),
  };
}

describe('local bare Git reader', () => {
  it('captures a real commit snapshot and detects exact subsequent changes without following Git symlinks', async () => {
    const root = await tempDirectory();
    const fixture = await repositoryFixture(root);
    const { catalog, scope } = scopedCatalog(fixture.managed);
    const reader = createLocalGitRepositoryReader(catalog);

    const baseline = await reader.read({ ...scope, repositoryKey: 'customer-product' });
    expect(baseline.change.state).toBe('baseline');
    expect(baseline.commit.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.snapshot.revision).toBe(baseline.commit.sha);
    expect(baseline.snapshot.files).toEqual([{ path: 'src.ts', content: 'export const value = 1;\n' }]);
    expect(baseline.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.evidence[0]?.source).toBe('repository');
    expect(baseline.evidence[0]?.reference).toContain('/commit/' + baseline.commit.sha);
    expect(baseline.candidate).toBeNull();

    await writeFile(join(fixture.working, 'src.ts'), 'export const value = 2;\n');
    await writeFile(join(root, 'outside-secret.ts'), 'not read by the monitoring adapter');
    await symlink(join(root, 'outside-secret.ts'), join(fixture.working, 'linked.ts'));
    git(['add', '-A'], fixture.working);
    git(['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'change'], fixture.working);
    git(['push', fixture.bare, 'HEAD:refs/heads/main'], fixture.working);

    const changed = await reader.read({ ...scope, repositoryKey: 'customer-product', previousRevision: baseline.commit.sha });
    expect(changed.change.state).toBe('changed');
    expect(changed.change.files).toEqual([
      { path: 'linked.ts', status: 'added' },
      { path: 'src.ts', status: 'modified' },
    ]);
    expect(changed.excludedSymlinks).toBe(1);
    expect(changed.snapshot.files).toEqual([{ path: 'src.ts', content: 'export const value = 2;\n' }]);
    expect(changed.candidate?.kind).toBe('repository_change');
    expect(changed.candidate?.evidence[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(changed)).not.toContain('not read by the monitoring adapter');
  });

  it('rejects a repository path that crosses a symlink beneath the managed root', async () => {
    const root = await tempDirectory();
    const fixture = await repositoryFixture(root);
    const link = join(fixture.managed, 'linked.git');
    await symlink(fixture.bare, link);
    const { catalog, scope } = scopedCatalog(fixture.managed, 'linked.git');
    const reader = createLocalGitRepositoryReader(catalog);
    await expect(reader.read({ ...scope, repositoryKey: 'customer-product' })).rejects.toThrow('repository_path_unsafe');
  });

  it('rejects external Git object alternates and source file size overflow', async () => {
    const root = await tempDirectory();
    const fixture = await repositoryFixture(root);
    const alternatesPath = join(fixture.bare, 'objects', 'info', 'alternates');
    await writeFile(alternatesPath, '/outside/object-store\n');
    const { catalog, scope } = scopedCatalog(fixture.managed);
    const reader = createLocalGitRepositoryReader(catalog);
    await expect(reader.read({ ...scope, repositoryKey: 'customer-product' })).rejects.toThrow('repository_external_objects_refused');

    await rm(alternatesPath);
    await writeFile(join(fixture.working, 'large.ts'), 'x'.repeat(1_048_577));
    git(['add', 'large.ts'], fixture.working);
    git(['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'oversize'], fixture.working);
    git(['push', fixture.bare, 'HEAD:refs/heads/main'], fixture.working);
    await expect(reader.read({ ...scope, repositoryKey: 'customer-product' })).rejects.toThrow('repository_source_file_limit');
  });
});
