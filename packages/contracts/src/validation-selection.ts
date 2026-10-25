import { z } from 'zod';

const validationTestPathSchema = z.string().min(1).max(512)
  .regex(/^(?:[A-Za-z0-9_@][A-Za-z0-9_@.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/)
  .refine(path => !path.split('/').includes('node_modules'));
function isValidTestNamePattern(pattern: string): boolean {
  for (const character of pattern) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return false;
  }
  try {
    RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
const validationTestNamePatternSchema = z.string().min(1).max(256).refine(isValidTestNamePattern);
export const validationTestSelectionSchema = z.object({
  files: z.array(validationTestPathSchema).min(1).max(20).refine(files => new Set(files).size === files.length),
  namePattern: validationTestNamePatternSchema.optional(),
}).strict();

