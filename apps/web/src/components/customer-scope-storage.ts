import { z } from 'zod';
import { customerScopeSchema } from '@gotchu/contracts';

const savedScopeSchema = customerScopeSchema.extend({ userId: z.string().min(1).max(256), autoNameApplication: z.boolean().optional() }).strict();

export function readSavedCustomerScope(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, userId: string) {
  const saved = storage.getItem(key);
  if (!saved) return null;
  try {
    const value: unknown = JSON.parse(saved);
    const parsed = savedScopeSchema.safeParse(value);
    if (parsed.success && parsed.data.userId === userId) return parsed.data;
  } catch { /* Malformed browser state is discarded. */ }
  storage.removeItem(key);
  return null;
}
