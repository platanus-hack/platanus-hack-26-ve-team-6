"""Run the installer's environment writer with temporary paths, without host changes."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class ServiceEnvironment(unittest.TestCase):
    def write_environments(self, integrations):
        installer = Path(__file__).with_name('install-services.sh').read_text()
        writer = installer.split("node --input-type=module <<'NODE'\n", 1)[1].split('\nNODE', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = {
                'AUTH_SECRET': 'fixture-session-secret', 'POSTGRES_HOST_PORT': '5432',
                'POSTGRES_DB': 'gotchu', 'REDIS_PASSWORD': 'fixture-redis-secret',
                'REDIS_HOST_PORT': '6379',
                **{f'{role}_DB_{field}': f'fixture-{role}-{field}'
                   for role in ['GOTCHU_API', 'GOTCHU_INGEST', 'GOTCHU_COORDINATOR']
                   for field in ['USERNAME', 'PASSWORD']},
                **integrations,
            }
            (folder / '.env').write_text(''.join(f'{key}={value}\n' for key, value in config.items()))
            writer = writer.replace("'/var/lib/gotchu-admin/state'", json.dumps(directory))
            writer = writer.replace('`/etc/gotchu/${name}.env`', f'`{directory}/${{name}}.env`')
            result = subprocess.run(['node', '--input-type=module'], input=writer,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return {name: (folder / f'{name}.env').read_text()
                    for name in ['web', 'coordinator', 'scanner']}

    def test_integrations_survive_reinstall_only_in_web(self):
        integrations = {
            'AUTH_GITHUB_ID': 'fixture-github-client',
            'AUTH_GITHUB_SECRET': 'fixture-github-secret',
            'AUTH_GOOGLE_ID': 'fixture-google-client',
            'AUTH_GOOGLE_SECRET': 'fixture-google-secret',
            'GOTCHU_GITHUB_READER_APP_FILE': '/etc/gotchu/github/reader-app.json',
            'GOTCHU_GITHUB_APP_SLUG': 'fixture-reader',
            'GOTCHU_GITHUB_WRITER_SECRET': 'must-not-reach-web',
        }
        environments = self.write_environments(integrations)
        for key, value in integrations.items():
            if key == 'GOTCHU_GITHUB_WRITER_SECRET':
                self.assertNotIn(value, environments['web'])
                self.assertNotIn(value, environments['coordinator'])
                continue
            self.assertIn(f'{key}="{value}"', environments['web'])
            self.assertNotIn(key, environments['scanner'])
            # Monitoring reads connected repositories with the same read-only App.
            if key == 'GOTCHU_GITHUB_READER_APP_FILE':
                self.assertIn(f'{key}="{value}"', environments['coordinator'])
            else:
                self.assertNotIn(key, environments['coordinator'])

    def test_coordinator_runs_monitoring_and_advisories(self):
        coordinator = self.write_environments({})['coordinator']
        self.assertIn('GOTCHU_MONITORING_ENABLED="true"', coordinator)
        self.assertIn('GOTCHU_MONITORING_OSV="true"', coordinator)
        self.assertNotIn('GOTCHU_GITHUB_READER_APP_FILE', coordinator)

    def test_integrations_remain_optional(self):
        environments = self.write_environments({})
        self.assertNotIn('AUTH_GOOGLE_ID', environments['web'])
        self.assertNotIn('AUTH_GITHUB_ID', environments['web'])
        self.assertIn('AUTH_SECRET="fixture-session-secret"', environments['web'])

    def test_dotenv_quoting_is_decoded_before_systemd_encoding(self):
        environments = self.write_environments({
            'AUTH_GOOGLE_ID': '"fixture-client"',
            'AUTH_GOOGLE_SECRET': "'fixture=secret'",
        })
        self.assertIn('AUTH_GOOGLE_ID="fixture-client"', environments['web'])
        self.assertIn('AUTH_GOOGLE_SECRET="fixture=secret"', environments['web'])


unittest.main()
