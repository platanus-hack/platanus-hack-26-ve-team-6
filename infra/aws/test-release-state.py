import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('release_state', Path(__file__).with_name('release-state.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
checksum = 'f' * 64
release = 'a' * 40 + '-200-1'


class DeploymentOrdering(unittest.TestCase):
    def setUp(self):
        self.state = dict(release=release, checksum=checksum, status='succeeded')

    def test_new_install(self):
        self.assertEqual(module.decision(None, release, checksum), 'install')

    def test_successful_retry_is_idempotent(self):
        self.assertEqual(module.decision(self.state, release, checksum), 'current')

    def test_changed_checksum_is_not_a_retry(self):
        with self.assertRaises(ValueError):
            module.decision(self.state, release, 'e' * 64)

    def test_older_workflow_cannot_replace_newer_release(self):
        with self.assertRaises(ValueError):
            module.decision(self.state, 'b' * 40 + '-199-2', checksum)

    def test_new_attempt_after_failure(self):
        self.state['status'] = 'failed'
        self.assertEqual(module.decision(self.state, 'a' * 40 + '-200-2', checksum), 'install')

    def test_uncertain_outcome_blocks_even_newer_work(self):
        for status in ['installing', 'recovery_required']:
            self.state['status'] = status
            with self.assertRaises(ValueError):
                module.decision(self.state, 'b' * 40 + '-201-1', checksum)

    def test_failed_attempt_requires_new_generation(self):
        self.state['status'] = 'failed'
        with self.assertRaises(ValueError):
            module.decision(self.state, release, checksum)


unittest.main()
