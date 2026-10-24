"""Validate a trusted release archive before extracting it with root privileges."""
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract_release(archive, destination, commit):
    destination = Path(destination)
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 150000 or sum(member.size for member in members) > 4 * 1024**3:
            raise ValueError('Release exceeds extraction limits')
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or member.mode & 0o7000:
                raise ValueError('Unsafe release member')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Special files are forbidden')
        # Python's data filter also rejects links escaping the destination, including link pivots.
        bundle.extractall(destination, members=members, filter='data')
    manifest = json.loads((destination / 'release.json').read_text())
    if manifest != {'commit': commit, 'nodeMajor': 24, 'platform': 'linux', 'arch': 'x64'}:
        raise ValueError('Release manifest does not match deployment')
    for entry in ['apps/web/.output/server/index.mjs', 'apps/coordinator/dist/main.js',
                  'apps/scanner/dist/main.js', 'packages/database/dist/migrate.js',
                  'infra/aws/compose.yaml', 'infra/aws/backup.sh']:
        if not (destination / entry).is_file():
            raise ValueError(f'Missing runtime file: {entry}')
    # Extraction uses a private umask; serving users need read/execute permission on the release.
    for root, directories, files in os.walk(destination):
        os.chmod(root, 0o755)
        for name in files:
            path = Path(root) / name
            if not path.is_symlink():
                os.chmod(path, 0o644 | (path.stat().st_mode & 0o111))


if __name__ == '__main__':
    extract_release(*sys.argv[1:])
