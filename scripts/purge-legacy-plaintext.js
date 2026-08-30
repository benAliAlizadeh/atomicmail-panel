import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const CONFIRMATION = 'DELETE LEGACY PLAINTEXT';

function assertNoSymlinks(target) {
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to delete symlink: ${current}`);
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
  }
}

export function purgeLegacyPlaintext(root, { confirmation = '' } = {}) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, 'data-before-am20');
  if (path.dirname(target) !== resolvedRoot || path.basename(target) !== 'data-before-am20') {
    throw new Error('Unsafe legacy purge target');
  }
  if (!fs.existsSync(target)) return { removed: false, target };
  assertNoSymlinks(target);
  if (confirmation !== CONFIRMATION) {
    const error = new Error(`Confirmation required: --confirm="${CONFIRMATION}"`);
    error.code = 'confirmation_required';
    error.target = target;
    throw error;
  }
  fs.rmSync(target, { recursive: true, force: false });
  return { removed: true, target };
}

export function runPurge(root = projectRoot, argv = process.argv.slice(2)) {
  const flag = argv.find((value) => value.startsWith('--confirm='));
  const confirmation = flag ? flag.slice('--confirm='.length) : '';
  try {
    const result = purgeLegacyPlaintext(root, { confirmation });
    console.log(result.removed
      ? 'Removed data-before-am20. Rotate any credentials that were ever stored there.'
      : 'Legacy plaintext snapshot is already absent.');
    return 0;
  } catch (error) {
    if (error?.code === 'confirmation_required') {
      console.error(`Legacy plaintext snapshot detected at: ${error.target}`);
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === scriptPath) process.exitCode = runPurge();
