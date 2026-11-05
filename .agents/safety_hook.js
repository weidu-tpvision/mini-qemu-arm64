import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, sandboxCommand } from './sandbox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { REPO_ROOT };

// Shell metacharacters: | & < > ` $ ( ) { } % ^ " ' and newline
const SHELL_META_REGEX = /[|&<>`$(){}%^"'\r\n]/;

/**
 * Checks whether a command string contains shell metacharacters.
 * Any command containing these characters cannot be auto-allowed.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function hasShellMeta(cmd) {
    if (typeof cmd !== 'string') return false;
    return SHELL_META_REGEX.test(cmd);
}

/**
 * Antigravity PreToolUse Safety & Autonomy Hook for `run_command`.
 *
 * Enforces:
 * 1. Strictly one atomic command per tool call (no `;`, `&&`, `||`).
 * 2. No inline code evaluation (`node -e`, `node -pe`, `node --eval=`, `python -c`,
 *    `powershell -c`, `bash -c`, `cmd /c`, `iex`, etc.).
 * 3. No shell file deletions (`rm`, `Remove-Item`, `del`, `rmdir`). Temporary test scripts
 *    are written to `tests/scratch/verify_<feature>.js` and overwritten via `write_file`.
 * 4. Native tool discipline (blocks shell inspection tools like `cat`, `grep`,
 *    `Get-Content`, `Select-String`, directing to `read_file` or `git ls-files`).
 * 5. Shell metacharacter check (hasShellMeta): any command with shell metacharacters
 *    falls through to `ask` rather than being auto-allowed.
 * 6. Node 24 Permission Model Sandbox Rewrite: auto-approved test runs, builders,
 *    and scratch scripts are rewritten to run under `node --permission` restricting
 *    read to REPO_ROOT and write to minimal output directories.
 * 7. Read-only git command allowlisting with strict token validation.
 */
export function evaluateCommand(payload) {
    const toolCall = payload?.toolCall;
    const toolName = toolCall?.name ? toolCall.name.toLowerCase() : '';
    if (!toolCall || (!['run_command', 'bash'].includes(toolName))) {
        // Never auto-approve a tool this function doesn't understand.
        return { decision: 'ask', reason: 'Unrecognized tool for command gate.' };
    }

    const args = toolCall.args || {};
    const rawCmd = typeof args.CommandLine === 'string'
        ? args.CommandLine
        : (typeof args.command === 'string'
            ? args.command
            : (typeof args.cmd === 'string' ? args.cmd : ''));
    const cmd = rawCmd.trim();

    if (!cmd) {
        return {
            decision: 'deny',
            reason: 'Empty CommandLine is not allowed.'
        };
    }

    // 1. Block command chaining (;, &&, ||) or multi-line commands
    if (/[;&|]{2}|;|[\r\n]/.test(cmd)) {
        return {
            decision: 'deny',
            reason: 'SAFETY VIOLATION: Command chaining (;, &&, ||, or newlines) is strictly forbidden. Execute one single atomic command per run_command call.'
        };
    }

    // 2. Block inline script execution (node -e, node -pe, python -c, powershell -c, iex, etc.)
    const isInlineEval =
        /\bnode(?:\.exe)?\s+(?:-(?!-)[a-zA-Z]*[ep]\b|--(?:eval|print)(?:=|\s|$))/i.test(cmd) ||
        /\b(?:powershell|pwsh)(?:\.exe)?\s+-(?:c|e|enc|command)[a-zA-Z]*(?:\s|:|=|$)/i.test(cmd) ||
        /\b(?:Invoke-Expression|iex)\b/i.test(cmd) ||
        /\bcmd(?:\.exe)?\s+[\/-]c\b/i.test(cmd) ||
        /\b(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\s+-c\b/i.test(cmd) ||
        /\b(?:python[0-9.]*|py)(?:\.exe)?\s+-c\b/i.test(cmd) ||
        /\b(?:perl|ruby)(?:\.exe)?\s+-e\b/i.test(cmd);

    if (isInlineEval) {
        return {
            decision: 'deny',
            reason: 'SAFETY VIOLATION: Inline code execution (node -e/--eval, python -c, powershell -c/iex, cmd /c, etc.) is strictly forbidden. Write your verification code to a dedicated test script in tests/scratch/ and execute it.'
        };
    }

    // 3. Block all shell deletion / destructive git commands
    if (
        /^(?:rm|del|erase|rmdir|rd|Remove-Item|ri)\b/i.test(cmd) ||
        /\brm\s+-[a-zA-Z]*[rRfF]/i.test(cmd) ||
        /\bRemove-Item\b/i.test(cmd) ||
        /\bgit\s+(?:clean|reset\s+--hard)\b/i.test(cmd)
    ) {
        return {
            decision: 'deny',
            reason: 'SAFETY & AUTONOMY VIOLATION: Do not run shell deletion commands (rm, Remove-Item, del). Write and overwrite scratch scripts in tests/scratch/ via write_file so no shell cleanup is ever needed.'
        };
    }

    // 4. Enforce Native Tool Discipline (no shelling out to read/search files)
    if (/^(?:cat|type|Get-Content|gc|Select-String|sls|grep|rg|findstr|dir|ls|Get-ChildItem|gci|head|tail)\b/i.test(cmd)) {
        return {
            decision: 'deny',
            reason: 'TOOL DISCIPLINE VIOLATION: Do not use shell commands to inspect or search files. Use the native `read_file` tool for file contents, and `git ls-files <dir>` for directory listing.'
        };
    }

    // Shell metacharacters block ANY auto-allow decision -> fall through to ask
    if (hasShellMeta(cmd)) {
        return {
            decision: 'ask',
            reason: `Command contains shell metacharacters and cannot be auto-approved.`
        };
    }

    // 5. Test runner commands: npm test, npm run test, node tools/run_tests.js
    if (cmd === 'npm test' || cmd === 'npm run test' || cmd === 'node tools/run_tests.js') {
        const waitMs = typeof args.WaitMsBeforeAsync === 'number' ? args.WaitMsBeforeAsync : 0;
        const response = {
            decision: 'allow',
            permissionOverrides: [`command(${cmd})`, `Bash(${cmd})`, `bash(${cmd})`],
            overwrite: {
                CommandLine: 'node tools/run_tests.js'
            }
        };
        if (waitMs < 10000) {
            response.overwrite.WaitMsBeforeAsync = 10000;
        }
        return response;
    }

    if (cmd === 'npm run build-elfs') {
        const waitMs = typeof args.WaitMsBeforeAsync === 'number' ? args.WaitMsBeforeAsync : 0;
        const response = {
            decision: 'allow',
            permissionOverrides: [`command(${cmd})`, `Bash(${cmd})`, `bash(${cmd})`],
            overwrite: {
                CommandLine: 'node tools/run_tests.js --build'
            }
        };
        if (waitMs < 10000) {
            response.overwrite.WaitMsBeforeAsync = 10000;
        }
        return response;
    }

    // 6. Scratch script execution: node tests/scratch/<name>.js [args]
    const scratchMatch = cmd.match(/^node\s+(tests[\\/]scratch[\\/][^\s]+)(?:\s+(.*))?$/);
    if (scratchMatch) {
        const rawFilePath = scratchMatch[1];
        const rawArgs = scratchMatch[2];
        const relScratchPath = rawFilePath.replace(/\\/g, '/');
        const absScratchPath = path.resolve(REPO_ROOT, relScratchPath);
        const absScratchDir = path.resolve(REPO_ROOT, 'tests', 'scratch');

        // Path traversal check: must stay inside tests/scratch
        const isInsideScratch = absScratchPath.startsWith(absScratchDir + path.sep) || absScratchPath === absScratchDir;
        if (!isInsideScratch || !relScratchPath.endsWith('.js')) {
            return {
                decision: 'deny',
                reason: 'SAFETY VIOLATION: Scratch script path traversal outside tests/scratch/ is forbidden.'
            };
        }

        // Validate argument tokens if any
        let fileAndArgs = relScratchPath;
        if (rawArgs) {
            const tokens = rawArgs.trim().split(/\s+/);
            const validTokens = tokens.every(t => /^[A-Za-z0-9_.\/:=,-]+$/.test(t));
            if (!validTokens) {
                return {
                    decision: 'ask',
                    reason: 'Scratch script arguments contain disallowed characters.'
                };
            }
            fileAndArgs = `${relScratchPath} ${rawArgs.trim()}`;
        }

        // Content scan defense-in-depth: Node 24 --permission does not restrict network
        if (fs.existsSync(absScratchPath)) {
            const content = fs.readFileSync(absScratchPath, 'utf8');
            const forbiddenPatterns = [
                { regex: /\bchild_process\b/, label: 'child_process' },
                { regex: /\bworker_threads\b/, label: 'worker_threads' },
                { regex: /\b(?:require\s*\(|import\s*(?:.*?from\s*)?\(?)\s*['"](?:node:)?(?:net|dgram|https?|http2|tls|dns)['"]/, label: 'network modules (net/http/https/dgram/tls/dns)' },
                { regex: /\bfetch\s*\(/, label: 'fetch API' },
                { regex: /\bWebSocket\b/, label: 'WebSocket API' },
                { regex: /\bprocess\s*\.\s*binding\b/, label: 'process.binding' },
                { regex: /\bimport\s*\(\s*(?!['"]\.[./])/, label: 'dynamic import of non-relative literal' },
                { regex: /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\b|\b(?:rmSync|rmdirSync|unlinkSync)\s*\(/, label: 'fs deletion APIs' }
            ];

            for (const rule of forbiddenPatterns) {
                if (rule.regex.test(content)) {
                    return {
                        decision: 'deny',
                        reason: `SAFETY VIOLATION: Scratch script contains forbidden ${rule.label}. Scratch scripts must be non-destructive test scripts.`
                    };
                }
            }
        }

        const waitMs = typeof args.WaitMsBeforeAsync === 'number' ? args.WaitMsBeforeAsync : 0;
        const response = {
            decision: 'allow',
            permissionOverrides: [`command(${cmd})`, `Bash(${cmd})`, `bash(${cmd})`],
            overwrite: {
                CommandLine: sandboxCommand(fileAndArgs),
                command: sandboxCommand(fileAndArgs)
            }
        };
        if (waitMs < 10000) {
            response.overwrite.WaitMsBeforeAsync = 10000;
        }
        return response;
    }

    // 7. Unit tests, ELF builders, and emulator CLI -> sandbox rewrite
    const isUnitTest = /^node\s+(?:\.\/|\.\\)?tests[\\/]test_[a-zA-Z0-9_]+\.js$/.test(cmd);
    const isElfBuilder = /^node\s+tools[\\/](?:elf_builder|build_[a-zA-Z0-9_]+_elf|generate_ui_preview)\.js$/.test(cmd);
    const isEmulatorRun = /^node\s+src[\\/](?:emulator|static_recompiler|arm2x86)\.js(?:\s+bin[\\/][a-zA-Z0-9_.-]+\.elf)?$/.test(cmd);

    if (isUnitTest || isElfBuilder || isEmulatorRun) {
        const fileAndArgs = cmd.replace(/^node\s+(?:\.\/|\.\\)?/, '').replace(/\\/g, '/');
        const waitMs = typeof args.WaitMsBeforeAsync === 'number' ? args.WaitMsBeforeAsync : 0;
        const response = {
            decision: 'allow',
            permissionOverrides: [`command(${cmd})`, `Bash(${cmd})`, `bash(${cmd})`],
            overwrite: {
                CommandLine: sandboxCommand(fileAndArgs),
                command: sandboxCommand(fileAndArgs)
            }
        };
        if (waitMs < 10000) {
            response.overwrite.WaitMsBeforeAsync = 10000;
        }
        return response;
    }

    // 8. Read-only Git commands
    if (/^git(?:\s+|$)/.test(cmd)) {
        const tokens = cmd.trim().split(/\s+/);
        if (tokens[0] === 'git' && tokens.length > 1) {
            const subCmd = tokens[1];
            if (['status', 'diff', 'log', 'ls-files', 'show', 'rev-parse'].includes(subCmd)) {
                const restTokens = tokens.slice(2);
                const allValidTokens = restTokens.every(t => /^[A-Za-z0-9_.\/:@~-]+$/.test(t));
                const hasForbiddenFlag = restTokens.some(t =>
                    t.startsWith('--output') ||
                    t.startsWith('--ext-diff') ||
                    t.startsWith('--exec') ||
                    t.startsWith('-o')
                );
                if (allValidTokens && !hasForbiddenFlag) {
                    return {
                        decision: 'allow',
                        permissionOverrides: [`command(${cmd})`]
                    };
                }
            } else if (subCmd === 'branch') {
                const restTokens = tokens.slice(2);
                const allowedBranchArgs = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current']);
                const allAllowed = restTokens.every(t => allowedBranchArgs.has(t));
                if (allAllowed) {
                    return {
                        decision: 'allow',
                        permissionOverrides: [`command(${cmd})`]
                    };
                }
            }
        }
    }

    // Default to asking user permission for any non-allowlisted command
    return {
        decision: 'ask',
        reason: `Command "${cmd}" is outside the pre-approved autonomous test/build allowlist.`
    };
}

/**
 * Antigravity PreToolUse Safety Hook for `write_file` and `edit_file`.
 *
 * Enforces:
 * 1. Missing path -> ask
 * 2. Path outside REPO_ROOT -> ask
 * 3. Protected guardrail files (.agents/**, .gemini/**, .git/**, GEMINI.md,
 *    AGENTS.md, package.json, .gitignore, tools/run_tests.js, tools/safety_hook.js) -> force_ask
 * 4. Otherwise -> allow
 */
export function evaluateFileWrite(payload) {
    const toolCall = payload?.toolCall;
    const toolName = toolCall?.name ? toolCall.name.toLowerCase() : '';
    if (!toolCall || (!['write_file', 'edit_file', 'write', 'edit'].includes(toolName))) {
        return { decision: 'ask', reason: 'Unrecognized tool for file-write gate.' };
    }

    const args = toolCall.args || {};
    const rawPath = args.Path || args.TargetFile || args.AbsolutePath || args.FilePath || args.path || args.file || args.filename;

    if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) {
        return {
            decision: 'ask',
            reason: 'Missing file path in write/edit operation.'
        };
    }

    const trimmedPath = rawPath.trim();
    let expandedPath = trimmedPath;
    if (expandedPath === '~' || expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
        expandedPath = path.join(os.homedir(), expandedPath.slice(1));
    }
    const resolvedPath = path.resolve(REPO_ROOT, expandedPath);
    const isWin = process.platform === 'win32';

    const normResolved = isWin ? resolvedPath.toLowerCase() : resolvedPath;
    const normRepoRoot = isWin ? REPO_ROOT.toLowerCase() : REPO_ROOT;
    const sep = path.sep;

    // Check if path is inside REPO_ROOT
    const isInsideRepo = normResolved === normRepoRoot || normResolved.startsWith(normRepoRoot + sep);
    if (!isInsideRepo) {
        return {
            decision: 'ask',
            reason: `Target path "${trimmedPath}" resolves outside the repository root.`
        };
    }

    // Relative path normalized with forward slashes
    const relPath = path.relative(REPO_ROOT, resolvedPath).replace(/\\/g, '/');
    const normRel = isWin ? relPath.toLowerCase() : relPath;

    // Guardrail: protected configuration, rules, workflow, and hook files
    const isProtected =
        normRel.startsWith('.agents/') ||
        normRel === '.agents' ||
        normRel.startsWith('.gemini/') ||
        normRel === '.gemini' ||
        normRel.startsWith('.git/') ||
        normRel === '.git' ||
        normRel === 'gemini.md' ||
        normRel === 'agents.md' ||
        normRel === 'package.json' ||
        normRel === '.gitignore' ||
        normRel === 'tools/run_tests.js' ||
        normRel === 'tools/safety_hook.js';

    if (isProtected) {
        return {
            decision: 'force_ask',
            reason: `SECURITY GUARDRAIL: Modifying protected configuration, rule, runner, or hook file "${relPath}" requires explicit user confirmation.`
        };
    }

    return { decision: 'allow' };
}

// Run when invoked directly as a hook command
const isMain = process.argv[1] && (
    path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase() ||
    path.basename(process.argv[1]) === path.basename(__filename)
);
if (isMain) {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        inputData += chunk;
    });
    process.stdin.on('end', () => {
        try {
            const payload = inputData.trim() ? JSON.parse(inputData) : {};
            const toolName = payload?.toolCall?.name ? payload.toolCall.name.toLowerCase() : '';
            let result;
            if (['write_file', 'edit_file', 'write', 'edit'].includes(toolName)) {
                result = evaluateFileWrite(payload);
            } else {
                result = evaluateCommand(payload);
            }
            process.stdout.write(JSON.stringify(result) + '\n');
        } catch (err) {
            process.stdout.write(JSON.stringify({
                decision: 'ask',
                reason: `Safety hook parse warning: ${err.message}`
            }) + '\n');
        }
    });
}
