"""Replay and crash reconciliation rules for the root-owned deployment ledger."""
import json
from pathlib import Path
import re
import sys


def decision(state, release, checksum):
    if not re.fullmatch(r'[a-f0-9]{40}-[0-9]{1,20}-[0-9]{1,5}', release):
        raise ValueError('Invalid release identifier')
    if not re.fullmatch(r'[a-f0-9]{64}', checksum):
        raise ValueError('Invalid release checksum')
    if state is None:
        return 'install'
    if state['status'] in ['installing', 'recovery_required']:
        raise ValueError('An unfinished deployment requires operator reconciliation')
    if state['release'] == release and state['checksum'] == checksum and state['status'] == 'succeeded':
        return 'current'
    generation = lambda value: tuple(map(int, value.split('-')[1:]))
    if generation(release) <= generation(state['release']):
        raise ValueError('Stale or repeated deployment rejected; rerun with a new attempt')
    return 'install'


if __name__ == '__main__':
    path, release, checksum = sys.argv[1:]
    state = json.loads(Path(path).read_text()) if Path(path).exists() else None
    print(decision(state, release, checksum))
