import { describe, expect, it } from 'vitest';
import { readSavedCustomerScope } from '../src/components/customer-scope-storage.js';

const scope = { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

function fixture(value: unknown) {
  const values = new Map([['scope', JSON.stringify(value)]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
  return { values, storage };
}

describe('saved customer scope ownership', () => {
  it('restores the scope only for its authenticated principal', () => {
    const { storage, values } = fixture({ ...scope, userId: 'google:42', autoNameApplication: false });
    expect(readSavedCustomerScope(storage, 'scope', 'google:42')).toEqual({ ...scope, userId: 'google:42', autoNameApplication: false });
    expect(readSavedCustomerScope(storage, 'scope', 'github:42')).toBeNull();
    expect(values.has('scope')).toBe(false);
  });

  it('discards legacy or malformed scope instead of assuming an owner', () => {
    for (const value of [scope, { ...scope, userId: '' }, { ...scope, userId: 'google:42', organizationId: 'invalid' }]) {
      const { storage, values } = fixture(value);
      expect(readSavedCustomerScope(storage, 'scope', 'google:42')).toBeNull();
      expect(values.size).toBe(0);
    }
  });
});
