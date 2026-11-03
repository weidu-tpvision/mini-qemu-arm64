// tools/server.js - Lightweight Dev Server for Mini-QEMU Web UI
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".elf": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const BINARY_DESCRIPTIONS = {
  "fib.elf": {
    name: "fib.elf",
    title: "Fibonacci (Iterative)",
    desc: "Computes 10th Fibonacci number (55) using registers X0, X1, X2 in a loop.",
    category: "Arithmetic & Loops"
  },
  "fib_rec.elf": {
    name: "fib_rec.elf",
    title: "Fibonacci (Recursive)",
    desc: "Computes recursive fib(10) with stack frames, function calls (BL), and STP/LDP.",
    category: "Recursion & Stack"
  },
  "hello.elf": {
    name: "hello.elf",
    title: "Hello World (sys_write)",
    desc: "Prints string to stdout using Linux ARM64 sys_write (syscall 64) and exits.",
    category: "System Calls & Strings"
  },
  "math_func.elf": {
    name: "math_func.elf",
    title: "Math & Subroutines",
    desc: "Tests subroutine calling (BL), stack preservation (STP/LDP), MUL, and UDIV.",
    category: "Functions & Math"
  },
  "heap_demo.elf": {
    name: "heap_demo.elf",
    title: "Static Libc & Heap Demo",
    desc: "Demonstrates dynamic heap expansion via sys_brk (214), string operations, and stdout via sys_write (64).",
    category: "Static Libc & Syscalls"
  },
  "graphics_pattern.elf": {
    name: "graphics_pattern.elf",
    title: "Graphics Test Pattern (SMPTE)",
    desc: "Level 1 MMIO graphics: Renders 8 vertical SMPTE color bars and 4 gradient ramps into VRAM (0x00800000).",
    category: "Graphics & Framebuffer"
  },
  "plasma.elf": {
    name: "plasma.elf",
    title: "Demoscene Color Plasma",
    desc: "Level 1 MMIO graphics: Procedural demoscene plasma field rendering 76,800 32-bit RGBA pixels into VRAM.",
    category: "Graphics & Framebuffer"
  }
};

function getAvailableBinaries() {
  const binDir = path.join(ROOT_DIR, "bin");
  if (!fs.existsSync(binDir)) return [];

  const files = fs.readdirSync(binDir).filter(f => f.endsWith(".elf"));
  return files.map(file => {
    const filePath = path.join(binDir, file);
    const stats = fs.statSync(filePath);
    const meta = BINARY_DESCRIPTIONS[file] || {
      name: file,
      title: file,
      desc: "ARM64 ELF executable binary",
      category: "Custom"
    };

    return {
      filename: file,
      title: meta.title,
      description: meta.desc,
      category: meta.category,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      url: `/bin/${file}`
    };
  });
}

function handleRequest(req, res) {
  // Enable CORS for all local requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(reqUrl.pathname);

  // 1. API Endpoints
  if (pathname === "/api/binaries") {
    const list = getAvailableBinaries();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(list, null, 2));
    return;
  }

  // 2. Static File Resolution
  if (pathname === "/" || pathname === "/index.html") {
    pathname = "/ui/index.html";
  }

  // Map allowed directory prefixes
  let filePath;
  if (pathname.startsWith("/ui/") || pathname.startsWith("/src/") || pathname.startsWith("/bin/")) {
    filePath = path.join(ROOT_DIR, pathname);
  } else {
    // Check inside ui/ by default
    filePath = path.join(ROOT_DIR, "ui", pathname);
  }

  filePath = path.normalize(filePath);

  // Prevent directory traversal outside ROOT_DIR
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  // Check file existence
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`404 Not Found: ${pathname}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": "no-cache"
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`500 Internal Server Error: ${err.message}`);
  }
}

// Start HTTP server with fallback port hunting
function startServer(startPort = 3000) {
  const server = http.createServer(handleRequest);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Server] Port ${startPort} is in use, trying port ${startPort + 1}...`);
      startServer(startPort + 1);
    } else {
      console.error("[Server Error]", err);
    }
  });

  server.listen(startPort, "127.0.0.1", () => {
    console.log("==================================================================");
    console.log("             Mini-QEMU ARM64 Interactive Web Emulator             ");
    console.log("==================================================================");
    console.log(`  UI Server running at: http://localhost:${startPort}/`);
    console.log(`  Serving Binaries:     ${getAvailableBinaries().length} ELF programs ready`);
    console.log("==================================================================");
    console.log("  Press Ctrl+C to stop the server.");
  });

  return server;
}

const requestedPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
startServer(requestedPort);
