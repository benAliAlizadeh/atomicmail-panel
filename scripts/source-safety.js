import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function inspectPath(blocked, relative, { includeEnv = false } = {}) {
  const value = normalize(relative);
  if (!value) return;
  if (/(^|\/)data-before-[^/]+(?:\/|$)/i.test(value)) blocked.add(value);
  if (/(^|\/)credentials\/[^/]+\/(?:credentials\.json|session\.jwt|capability\.jwt)$/i.test(value)) blocked.add(value);
  if (includeEnv && /(^|\/)\.env$/i.test(value)) blocked.add(value);
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage']);

function walkPhysicalTree(root, blocked, current = '', { includeLocalEnv = false } = {}) {
  const absolute = path.join(root, current);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relative = normalize(path.join(current, entry.name));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (/^data-before-/i.test(entry.name)) {
        inspectPath(blocked, relative);
        continue;
      }
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walkPhysicalTree(root, blocked, relative, { includeLocalEnv });
      continue;
    }
    if (entry.isFile()) inspectPath(blocked, relative, { includeEnv: includeLocalEnv });
  }
}

function trackedRepositoryFiles(root) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0) return [];
  const deleted = spawnSync('git', ['ls-files', '--deleted', '-z'], { cwd: root, encoding: 'utf8' });
  const deletedSet = new Set(deleted.status === 0 ? deleted.stdout.split('\0').filter(Boolean).map(normalize) : []);
  return tracked.stdout.split('\0').filter(Boolean).map(normalize).filter((file) => !deletedSet.has(file));
}

export function findUnsafeSourceArtifacts(root, {
  trackedFiles = null,
  includeLocalEnv = false,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const blocked = new Set();

  if (fs.existsSync(absoluteRoot)) walkPhysicalTree(absoluteRoot, blocked, '', { includeLocalEnv });
  const files = trackedFiles ?? trackedRepositoryFiles(absoluteRoot);
  for (const file of files) inspectPath(blocked, file, { includeEnv: true });
  return [...blocked].sort();
}

export function assertSafeSourceTree(root, options = {}) {
  const blocked = findUnsafeSourceArtifacts(root, options);
  if (!blocked.length) return;
  const error = new Error([
    'Source safety check failed. Remove these plaintext/operator-state artifacts before verify, ZIP, commit, or Docker build:',
    ...blocked.map((file) => ` - ${file}`),
    'Keep runtime state only under ignored data/, secrets/, and backups/ directories.',
  ].join('\n'));
  error.code = 'unsafe_source_artifacts';
  error.artifacts = blocked;
  throw error;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const root = path.resolve(path.dirname(currentFile), '..');
  const strict = process.argv.includes('--strict');
  try {
    assertSafeSourceTree(root, { includeLocalEnv: strict });
    console.log(`Source safety: OK${strict ? ' (strict)' : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
