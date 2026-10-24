import { describe, expect, it } from 'vitest';
import { dependencyCommitMessage, expectedDependencyCommitSha } from '../src/git-commit.js';

describe('GitHub dependency commit identity', () => {
  it('matches the commit object created by the GitHub Git Data API', () => {
    const message = dependencyCommitMessage({ packageName: 'minimist', fromVersion: '1.2.5', toVersion: '1.2.6' });
    expect(expectedDependencyCommitSha(
      '57eb8b3496aac1619cf2e67643a99b46e88f1ad9',
      '6cd289576e27fcfa373ef4dab881c65b2f766a2a',
      message,
    )).toBe('0c1b86aadfe903795fbc42a86a52f37860300d63');
  });
});
