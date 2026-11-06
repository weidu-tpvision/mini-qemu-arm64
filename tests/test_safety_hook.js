// tests/test_safety_hook.js - Unit tests for safety hook command & file-write evaluation
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateCommand, evaluateFileWrite, hasShellMeta, makeOverrides, REPO_ROOT } from '../.agents/safety_hook.js';

console.log('Running Safety Hook Unit Tests...\n');

// 1. Chaining denied
{
  const res1 = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/test_jit.js; npm test' } } });
  assert.strictEqual(res1.decision, 'deny');
  assert.ok(res1.reason?.includes('Command chaining'));

  const res2 = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'npm test && node tools/build.js' } } });
  assert.strictEqual(res2.decision, 'deny');

  const res3 = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git status || git diff' } } });
  assert.strictEqual(res3.decision, 'deny');
  console.log('[PASS] Command chaining denied (;, &&, ||)');
}

// 2. Inline evaluation denied: node -pe "1", node --eval=x, powershell -enc abc
{
  const resNodePe = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node -pe "1"' } } });
  assert.strictEqual(resNodePe.decision, 'deny');
  assert.ok(resNodePe.reason?.includes('Inline code execution'));

  const resNodeEval = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node --eval=x' } } });
  assert.strictEqual(resNodeEval.decision, 'deny');

  const resPsEnc = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'powershell -enc abc' } } });
  assert.strictEqual(resPsEnc.decision, 'deny');

  const resPwshC = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'pwsh -command Write-Host' } } });
  assert.strictEqual(resPwshC.decision, 'deny');

  const resIex = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'Invoke-Expression test' } } });
  assert.strictEqual(resIex.decision, 'deny');

  const resCmdC = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'cmd /c dir' } } });
  assert.strictEqual(resCmdC.decision, 'deny');
  console.log('[PASS] Inline script execution denied (node -pe, node --eval=, powershell -enc, iex, cmd /c)');
}

// 3. Shell deletions denied: Remove-Item x
{
  const resDel = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'Remove-Item x' } } });
  assert.strictEqual(resDel.decision, 'deny');
  assert.ok(resDel.reason?.includes('shell deletion commands'));

  const resRm = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf node_modules' } } });
  assert.strictEqual(resRm.decision, 'deny');
  console.log('[PASS] Shell deletions denied (Remove-Item, rm)');
}

// 4. Shell file inspection denied: cat a (suggests read_file & git ls-files)
{
  const resCat = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'cat a' } } });
  assert.strictEqual(resCat.decision, 'deny');
  assert.ok(resCat.reason?.includes('read_file'));
  assert.ok(resCat.reason?.includes('git ls-files <dir>'));

  const resGc = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'Get-Content foo.txt' } } });
  assert.strictEqual(resGc.decision, 'deny');
  console.log('[PASS] Shell inspection denied with read_file & git ls-files suggestions');
}

// 5. Shell metacharacters block auto-allow
{
  const resPipe = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/a.js | Out-File src/x.js' } } });
  assert.notStrictEqual(resPipe.decision, 'allow');
  assert.strictEqual(resPipe.decision, 'ask');

  const resSubshell = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/a.js $(x)' } } });
  assert.notStrictEqual(resSubshell.decision, 'allow');
  assert.strictEqual(resSubshell.decision, 'ask');

  assert.strictEqual(hasShellMeta('node tests/scratch/a.js | Out-File src/x.js'), true);
  assert.strictEqual(hasShellMeta('node tests/scratch/a.js $(x)'), true);
  assert.strictEqual(hasShellMeta('node tests/test_jit.js'), false);
  console.log('[PASS] Shell metacharacters successfully block auto-approval');
}

// 6. Path traversal outside tests/scratch is not allowed
{
  const resTraversal = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/../../evil.js' } } });
  assert.notStrictEqual(resTraversal.decision, 'allow');
  assert.strictEqual(resTraversal.decision, 'deny');
  console.log('[PASS] Scratch path traversal strictly blocked');
}

// 7. Scratch scripts: clean fixture vs forbidden imports
{
  const scratchDir = path.join(REPO_ROOT, 'tests', 'scratch');
  fs.mkdirSync(scratchDir, { recursive: true });

  // A clean scratch script fixture
  const cleanPath = path.join(scratchDir, 'hooktest_clean.js');
  fs.writeFileSync(cleanPath, 'console.log("clean scratch test");\n', 'utf8');

  const resClean = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/hooktest_clean.js' } } });
  assert.strictEqual(resClean.decision, 'allow');
  assert.strictEqual(resClean.overwrite?.CommandLine, undefined);
  assert.ok(resClean.permissionOverrides.includes('command(node tests/scratch/hooktest_clean.js)'));

  // Fixture containing dynamic import of child_process
  const badImportPath = path.join(scratchDir, 'hooktest_bad_import.js');
  fs.writeFileSync(badImportPath, 'const cp = await import("node:child_process");\n', 'utf8');
  const resBadImport = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/hooktest_bad_import.js' } } });
  assert.strictEqual(resBadImport.decision, 'deny');
  assert.ok(resBadImport.reason?.includes('child_process') || resBadImport.reason?.includes('dynamic import'));

  // Fixture with require('net')
  const badNetPath = path.join(scratchDir, 'hooktest_bad_net.js');
  fs.writeFileSync(badNetPath, 'const net = require("net");\n', 'utf8');
  const resBadNet = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/scratch/hooktest_bad_net.js' } } });
  assert.strictEqual(resBadNet.decision, 'deny');
  assert.ok(resBadNet.reason?.includes('network modules'));

  console.log('[PASS] Scratch content defense-in-depth scan verified (clean -> allow, bad -> deny)');
}

// 8. Unit test auto-allow with clean command line
{
  const resJit = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/test_jit.js' } } });
  assert.strictEqual(resJit.decision, 'allow');
  assert.strictEqual(resJit.overwrite?.CommandLine, undefined);
  assert.ok(resJit.permissionOverrides.includes('command(node tests/test_jit.js)'));
  console.log('[PASS] node tests/test_jit.js auto-approved cleanly without rewrite');
}

// 9. npm test & run_tests.js auto-approval
{
  const resNpmTest = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } });
  assert.strictEqual(resNpmTest.decision, 'allow');
  assert.ok(resNpmTest.permissionOverrides.includes('command(npm test)'));

  const resRunTests = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tools/run_tests.js' } } });
  assert.strictEqual(resRunTests.decision, 'allow');

  const resRunTestsBuild = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tools/run_tests.js --build' } } });
  assert.strictEqual(resRunTestsBuild.decision, 'allow');

  const resNpmRunBuild = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'npm run build-elfs' } } });
  assert.strictEqual(resNpmRunBuild.decision, 'allow');
  assert.ok(resNpmRunBuild.permissionOverrides.includes('command(npm run build-elfs)'));
  console.log('[PASS] npm test, build-elfs, and run_tests.js --build auto-approved');
}

// 10. Read-only Git commands
{
  const resGitStatus = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } });
  assert.strictEqual(resGitStatus.decision, 'allow');

  const resGitBranch = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git branch' } } });
  assert.strictEqual(resGitBranch.decision, 'allow');

  const resGitBranchD = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git branch -D main' } } });
  assert.notStrictEqual(resGitBranchD.decision, 'allow');
  assert.strictEqual(resGitBranchD.decision, 'ask');

  const resGitDiffOut = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git diff --output=x' } } });
  assert.notStrictEqual(resGitDiffOut.decision, 'allow');
  assert.strictEqual(resGitDiffOut.decision, 'ask');

  const resGitPush = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'git push' } } });
  assert.strictEqual(resGitPush.decision, 'ask');
  console.log('[PASS] Read-only git allowlisting and write/destructive git containment verified');
}

// 11. Low WaitMsBeforeAsync normalized to 10000
{
  const resWait = evaluateCommand({ toolCall: { name: 'run_command', args: { CommandLine: 'node tests/test_jit.js', WaitMsBeforeAsync: 1000 } } });
  assert.strictEqual(resWait.decision, 'allow');
  assert.strictEqual(resWait.overwrite?.WaitMsBeforeAsync, 10000);
  console.log('[PASS] WaitMsBeforeAsync normalized to 10000');
}

// 12. File Write Protection (evaluateFileWrite)
{
  // Protected guardrail files -> force_ask
  const resHooks = evaluateFileWrite({ toolCall: { name: 'write_file', args: { Path: '.agents/hooks.json', Content: '{}' } } });
  assert.strictEqual(resHooks.decision, 'force_ask');
  assert.ok(resHooks.reason?.includes('SECURITY GUARDRAIL'));

  const resGemini = evaluateFileWrite({ toolCall: { name: 'edit_file', args: { Path: 'GEMINI.md' } } });
  assert.strictEqual(resGemini.decision, 'force_ask');

  const resPkg = evaluateFileWrite({ toolCall: { name: 'write_file', args: { Path: 'package.json' } } });
  assert.strictEqual(resPkg.decision, 'force_ask');

  const resRunner = evaluateFileWrite({ toolCall: { name: 'edit_file', args: { Path: 'tools/run_tests.js' } } });
  assert.strictEqual(resRunner.decision, 'force_ask');

  const resHookShim = evaluateFileWrite({ toolCall: { name: 'edit_file', args: { Path: 'tools/safety_hook.js' } } });
  assert.strictEqual(resHookShim.decision, 'force_ask');

  // Normal project files -> allow
  const resCpuRel = evaluateFileWrite({ toolCall: { name: 'edit_file', args: { Path: 'src/cpu.js' } } });
  assert.strictEqual(resCpuRel.decision, 'allow');

  const resCpuAbs = evaluateFileWrite({ toolCall: { name: 'edit_file', args: { Path: path.join(REPO_ROOT, 'src', 'cpu.js') } } });
  assert.strictEqual(resCpuAbs.decision, 'allow');

  // Outside repo -> ask
  const resOutside = evaluateFileWrite({ toolCall: { name: 'write_file', args: { Path: 'C:\\Windows\\x' } } });
  assert.strictEqual(resOutside.decision, 'ask');

  // Missing path -> ask
  const resMissing = evaluateFileWrite({ toolCall: { name: 'write_file', args: {} } });
  assert.strictEqual(resMissing.decision, 'ask');

  console.log('[PASS] evaluateFileWrite guardrail protection verified (force_ask for guardrail files, allow inside repo, ask outside)');
}

console.log('\nAll Safety Hook Unit Tests Passed Successfully!');
