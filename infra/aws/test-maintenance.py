"""Exercise systemd boundary states with a fake CLI; no host services are changed."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MaintenanceWait(unittest.TestCase):
    def run_wait(self, states, error=False):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            systemctl = folder / 'systemctl'
            systemctl.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
if os.environ['FAIL'] == 'true': sys.exit(1)
path=Path(os.environ['COUNTS']) / sys.argv[2]
count=int(path.read_text()) if path.exists() else 0
path.write_text(str(count+1))
states=json.loads(os.environ['STATES'])
print(states[min(count,len(states)-1)])
''')
            systemctl.chmod(0o755)
            sleep = folder / 'sleep'
            sleep.write_text('#!/bin/sh\nexit 0\n')
            sleep.chmod(0o755)
            import json
            result = subprocess.run(['bash', str(Path(__file__).with_name('wait-maintenance.sh'))],
                                    env={**os.environ, 'PATH': directory + ':' + os.environ['PATH'],
                                         'STATES': json.dumps(states), 'COUNTS': directory,
                                         'FAIL': str(error).lower()}, capture_output=True, text=True)
            counts = [int(path.read_text()) for path in folder.glob('*.service')]
            return result.returncode, counts

    def test_running_oneshot_is_not_quiescent(self):
        status, counts = self.run_wait(['activating', 'inactive'])
        self.assertEqual(status, 0)
        self.assertEqual(counts, [2, 2])

    def test_reloading_and_stopping_wait(self):
        status, counts = self.run_wait(['reloading', 'deactivating', 'failed'])
        self.assertEqual(status, 0)
        self.assertEqual(counts, [3, 3])

    def test_unknown_and_unreadable_fail_closed(self):
        self.assertNotEqual(self.run_wait(['unknown'])[0], 0)
        self.assertNotEqual(self.run_wait(['inactive'], error=True)[0], 0)


unittest.main()
