import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('release_archive', Path(__file__).with_name('release-archive.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveSafety(unittest.TestCase):
    def reject(self, members):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'release.tgz'
            destination = Path(directory) / 'app'
            destination.mkdir()
            with tarfile.open(archive, 'w:gz') as bundle:
                for member in members:
                    bundle.addfile(member, io.BytesIO(b'') if member.isfile() else None)
            with self.assertRaises((ValueError, tarfile.FilterError)):
                module.extract_release(archive, destination, 'a' * 40)
            self.assertFalse((Path(directory) / 'escaped').exists())

    def test_parent_escape(self):
        self.reject([tarfile.TarInfo('../escaped')])

    def test_absolute_path(self):
        self.reject([tarfile.TarInfo('/tmp/escaped')])

    def test_symlink_pivot(self):
        link = tarfile.TarInfo('node_modules/pivot')
        link.type, link.linkname = tarfile.SYMTYPE, '../..'
        self.reject([link, tarfile.TarInfo('node_modules/pivot/escaped')])

    def test_device(self):
        member = tarfile.TarInfo('device')
        member.type = tarfile.CHRTYPE
        self.reject([member])

    def test_privileged_mode(self):
        member = tarfile.TarInfo('privileged')
        member.mode = 0o4755
        self.reject([member])

    def test_invalid_manifest(self):
        member = tarfile.TarInfo('release.json')
        self.reject([member])

    def test_wrong_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'release.tgz'
            payload = json.dumps(dict(commit='b' * 40, nodeMajor=24, platform='linux', arch='x64')).encode()
            with tarfile.open(archive, 'w:gz') as bundle:
                member = tarfile.TarInfo('release.json')
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
            with self.assertRaisesRegex(ValueError, 'manifest does not match deployment'):
                module.extract_release(archive, Path(directory) / 'app', 'a' * 40)


unittest.main()
