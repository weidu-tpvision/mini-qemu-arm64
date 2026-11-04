// tools/run_tests.js - Trusted test and ELF builder runner enforcing Node 24 permission sandbox
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, sandboxFlags } from '../.agents/sandbox.js';

// Ordered list of tests from package.json plus test_safety_hook.js
const TEST_FILES = [
  'tests/test_decoder.js',
  'tests/test_ui_api.js',
  'tests/test_server.js',
  'tests/test_syscalls.js',
  'tests/test_abi_and_compiler.js',
  'tests/test_graphics.js',
  'tests/test_interactive.js',
  'tests/test_dynamic_memory.js',
  'tests/test_neon_fp.js',
  'tests/test_jit.js',
  'tests/test_safety_hook.js'
];

// Ordered list of builders from package.json "build-elfs"
const BUILDER_FILES = [
  'tools/elf_builder.js',
  'tools/build_hello_elf.js',
  'tools/build_math_elf.js',
  'tools/build_fib_rec_elf.js',
  'tools/build_heap_demo_elf.js',
  'tools/build_graphics_elf.js',
  'tools/build_interactive_elf.js',
  'tools/build_dynamic_memory_elf.js',
  'tools/build_neon_matrix_elf.js'
];

/**
 * Explicit, narrowly-scoped permission exceptions for specific test suites.
 * Keep this EMPTY unless strictly necessary: flags like --allow-child-process
 * let an (agent-editable) test spawn unsandboxed processes = full sandbox escape.
 * (tests/test_server.js now starts the server in-process instead.)
 */
const EXCEPTIONS = {};

function main() {
  const isBuild = process.argv.includes('--build');
  const targetFiles = isBuild ? BUILDER_FILES : TEST_FILES;
  const label = isBuild ? 'ELF Builders' : 'Test Suites';

  console.log(`\n======================================================================`);
  console.log(`  Running ${targetFiles.length} ${label} under Node 24 Permission Sandbox`);
  console.log(`======================================================================\n`);

  const startTime = Date.now();
  let passedCount = 0;

  for (const file of targetFiles) {
    const normFile = file.replace(/\\/g, '/');
    const extraFlags = EXCEPTIONS[normFile] || [];

    const args = [...sandboxFlags(), ...extraFlags, file];
    const res = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      cwd: REPO_ROOT
    });

    if (res.status !== 0) {
      console.error(`\n[FAILURE] ${file} exited with code ${res.status}`);
      process.exit(res.status ?? 1);
    }

    passedCount++;
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n======================================================================`);
  console.log(`  All ${passedCount}/${targetFiles.length} ${label} Passed Successfully! (${durationSec}s)`);
  console.log(`======================================================================\n`);
}

main();
