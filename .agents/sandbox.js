import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Returns Node 24 permission-model flags restricting file-system reads
 * to the repository root and writes to dedicated output directories.
 */
export function sandboxFlags() {
  const writeDirs = [
    path.join(REPO_ROOT, 'tests', 'scratch'),
    path.join(REPO_ROOT, 'bin'),
    path.join(REPO_ROOT, 'out'),
    path.join(REPO_ROOT, 'docs')
  ];

  return [
    '--permission',
    `--allow-fs-read=${REPO_ROOT}`,
    ...writeDirs.map(dir => `--allow-fs-write=${dir}`)
  ];
}

function quoteIfSpaces(p) {
  return p.includes(' ') ? `"${p}"` : p;
}

/**
 * Constructs a complete sandboxed Node command string.
 * Quotes paths only if they contain spaces.
 *
 * @param {string} fileAndArgs - Target file and optional arguments
 * @returns {string} - "node <flags...> <fileAndArgs>"
 */
export function sandboxCommand(fileAndArgs) {
  const formattedFlags = sandboxFlags().map(flag => {
    const eqIdx = flag.indexOf('=');
    if (eqIdx === -1) return flag;
    const key = flag.slice(0, eqIdx);
    const val = flag.slice(eqIdx + 1);
    return `${key}=${quoteIfSpaces(val)}`;
  });

  return `node ${formattedFlags.join(' ')} ${fileAndArgs}`;
}
