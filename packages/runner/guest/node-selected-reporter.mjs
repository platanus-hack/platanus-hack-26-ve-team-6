import { writeSync } from 'node:fs';
import { summarizeNodeEvents } from './selected-node.mjs';

export default async function* report(source) {
  const result = await summarizeNodeEvents(source, (diagnostic) => {
    process.stderr.write(`GOTCHU_SELECTED_REPORT_INCOMPLETE ${JSON.stringify(diagnostic)}\n`);
  });
  const bytes = Buffer.from(JSON.stringify(result));
  // fd 3 belongs to the guest agent. Test stdout and customer artifacts are not inputs.
  const written = writeSync(3, bytes);
  if (written !== bytes.length) throw new Error('Selected Node reporter channel was truncated');
  yield '';
}
