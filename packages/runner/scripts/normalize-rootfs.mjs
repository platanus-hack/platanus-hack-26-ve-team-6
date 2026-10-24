import { spawnSync } from 'node:child_process';

const image = process.argv[2];
if (!image) throw new Error('Usage: normalize-rootfs.mjs <ext4-image>');

const directories = [2];
const visited = new Set();
const inodes = new Set([2]);
while (directories.length > 0) {
  const directory = directories.pop();
  if (directory === undefined || visited.has(directory)) continue;
  visited.add(directory);
  const result = spawnSync('debugfs', ['-R', `ls -p -r <${directory}>`, image], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `debugfs could not read inode ${directory}`);
  for (const line of result.stdout.split('\n')) {
    const match = /^\/(\d+)\/([0-7]+)\/\d+\/\d+\/([^/]*)\//.exec(line);
    if (!match) continue;
    const inode = Number(match[1]);
    const mode = Number.parseInt(match[2] ?? '', 8);
    const name = match[3] ?? '';
    if (inode === 0) continue;
    if (!Number.isSafeInteger(inode)) throw new Error(`Invalid ext4 inode entry: ${line}`);
    inodes.add(inode);
    if ((mode & 0o170000) === 0o040000 && name !== '.' && name !== '..' && !visited.has(inode)) {
      directories.push(inode);
    }
  }
}

const commands = ['set_current_time 1700000000', ...[...inodes].map((inode) => `sif <${inode}> ctime 1700000000`)].join('\n');
const normalized = spawnSync('debugfs', ['-w', '-f', '-', image], {
  encoding: 'utf8',
  input: `${commands}\n`,
  env: { ...process.env, E2FSPROGS_FAKE_TIME: '1700000000' },
});
if (normalized.status !== 0) throw new Error(normalized.stderr || 'debugfs failed to normalize ext4 inode creation times');
