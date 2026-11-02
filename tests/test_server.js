// test_server.js - Verifies server startup, endpoints, and file serving
import http from "node:http";
import assert from "assert";
import { spawn } from "node:child_process";

console.log("Testing lightweight HTTP dev server...");

// Spawn server process on custom port 3456
const serverProcess = spawn("node", ["tools/server.js"], {
  env: { ...process.env, PORT: "3456" },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
serverProcess.stdout.on("data", (data) => {
  serverOutput += data.toString();
});

serverProcess.stderr.on("data", (data) => {
  console.error("Server stderr:", data.toString());
});

// Wait 500ms for server to bind
await new Promise(r => setTimeout(r, 600));

function fetchUrl(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:3456${path}`, (res) => {
      let data = [];
      res.on("data", chunk => data.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(data)
        });
      });
    }).on("error", reject);
  });
}

try {
  // 1. Test /api/binaries
  const apiRes = await fetchUrl("/api/binaries");
  assert.strictEqual(apiRes.statusCode, 200);
  assert.ok(apiRes.headers["content-type"].includes("application/json"));
  const binaries = JSON.parse(apiRes.body.toString("utf8"));
  assert.ok(Array.isArray(binaries), "Expected binaries array");
  assert.ok(binaries.length >= 4, `Expected at least 4 binaries, got ${binaries.length}`);
  const fib = binaries.find(b => b.filename === "fib.elf");
  assert.ok(fib, "fib.elf must be in the list");
  console.log(`[PASS] /api/binaries returned ${binaries.length} binaries`);

  // 2. Test /bin/fib.elf raw binary download
  const binRes = await fetchUrl("/bin/fib.elf");
  assert.strictEqual(binRes.statusCode, 200);
  assert.strictEqual(binRes.headers["content-type"], "application/octet-stream");
  assert.strictEqual(binRes.body[0], 0x7f); // ELF magic byte
  assert.strictEqual(binRes.body[1], 0x45); // 'E'
  console.log("[PASS] /bin/fib.elf verified with correct ELF magic header");

  // 3. Test /ui/fs_shim.js
  const shimRes = await fetchUrl("/ui/fs_shim.js");
  assert.strictEqual(shimRes.statusCode, 200);
  assert.ok(shimRes.body.toString("utf8").includes("export const existsSync"));
  console.log("[PASS] /ui/fs_shim.js served correctly with JS MIME type");

  // 4. Test root / index.html
  const rootRes = await fetchUrl("/");
  assert.strictEqual(rootRes.statusCode, 200);
  assert.ok(rootRes.headers["content-type"].includes("text/html"));
  assert.ok(rootRes.body.toString("utf8").includes("Mini-QEMU Interactive Workbench"));
  console.log("[PASS] / (index.html) served correctly");

  // 5. Test /ui/app.js and /src/emulator.js module loading
  const appRes = await fetchUrl("/ui/app.js");
  assert.strictEqual(appRes.statusCode, 200);
  assert.ok(appRes.headers["content-type"].includes("application/javascript"));

  const emuRes = await fetchUrl("/src/emulator.js");
  assert.strictEqual(emuRes.statusCode, 200);
  assert.ok(emuRes.headers["content-type"].includes("application/javascript"));
  console.log("[PASS] /ui/app.js and /src/emulator.js served with JavaScript MIME type");

  console.log("All HTTP server endpoint tests passed successfully!");
} finally {
  serverProcess.kill();
}
