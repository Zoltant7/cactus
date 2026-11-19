// cactus-node.mjs — Node.js bridge that loads the same cactus.js + cactus.wasm
// + mirage.cact files the browser uses, and exposes cactus_describe() over
// HTTP so Node-RED (or anything else) can call it.
//
// Two modes:
//   1. Service:    node cactus-node.mjs --serve           (listens on :3002)
//   2. One-shot:   node cactus-node.mjs path/to/image.jpg (prints JSON, exits)
//
// Layout expected next to this file:
//   vendor/cactus.js
//   vendor/cactus.wasm
//   models/mirage.cact
//
// Requires: Node 18+, and `sharp` for image decode (npm i sharp).
import { createRequire } from "node:module";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

globalThis.require = require;
globalThis.__filename = __filename;
globalThis.__dirname = __dirname;


const VENDOR = join(__dirname, "vendor");
const MODELS = join(__dirname, "models");
const CACTUS_JS = join(VENDOR, "cactus.js");
const CACTUS_WASM = join(VENDOR, "cactus.wasm");
const MODEL_PATH = join(MODELS, "mirage.cact");

// Same constants the browser app uses — keep them in sync with app.js.
const OUT_CAPACITY = 16 * 1024 * 1024; // 16 MB output buffer
const MAX_EDGE = 1024; // longest side handed to the model
const CACTUS_VISION = 4; // bit flag in _cactus_models() for vision models

// ────────────────────────────────────────────────────────── engine loading

let enginePromise = null;

async function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    for (const p of [CACTUS_JS, CACTUS_WASM, MODEL_PATH]) {
      if (!existsSync(p)) {
        throw new Error(`Missing file: ${p}`);
      }
    }

    // cactus.js is an Emscripten MODULARIZE build: `var createCactus = (() => {...})`.
    // Indirect eval runs it in global scope so the var becomes a global.
    const jsCode = await readFile(CACTUS_JS, "utf8");
    (0, eval)(jsCode); // eslint-disable-line no-eval
    const createCactus = globalThis.createCactus;
    if (typeof createCactus !== "function") {
      throw new Error(
        "cactus.js loaded but did not expose createCactus. The file may be truncated.",
      );
    }

    // Pass the wasm bytes in directly — skips any fetch() attempt.
    const wasmBinary = await readFile(CACTUS_WASM);
    const Module = await createCactus({
      wasmBinary,
      // Silence Emscripten's default stdout/stderr noise.
      print: () => {},
      printErr: () => {},
    });

    // Load the model archive into the engine's heap.
    const weights = await readFile(MODEL_PATH);
    const ptr = Module._malloc(weights.length);
    if (!ptr) throw new Error("out of memory allocating weights");
    Module.HEAPU8.set(weights, ptr);
    const code = Module._cactus_load(ptr, BigInt(weights.length));
    Module._free(ptr);
    if (code < 0) {
      const msg = Module.UTF8ToString(Module._cactus_last_error());
      throw new Error(msg || "cactus_load failed");
    }
    if (!(Module._cactus_models() & CACTUS_VISION)) {
      throw new Error("the loaded archive is not a Mirage vision model");
    }
    console.error(`[cactus] engine ready, model: ${weights.length} bytes`);
    return Module;
  })();
  return enginePromise;
}

// ────────────────────────────────────────────────────────── image decoding

async function imageToRGB(buffer) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error(
      "sharp is not installed. Run:  npm i sharp   (in this folder)",
    );
  }
  const img = sharp(buffer, { failOn: "none" });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read image dimensions");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  // Force 3-channel RGB output.
  const raw = await img.resize(w, h).removeAlpha().raw().toBuffer();
  return { rgb: raw, w, h };
}

// ────────────────────────────────────────────────────────── describe

function writeCString(Module, str) {
  const bytes = Buffer.from(str, "utf8");
  const ptr = Module._malloc(bytes.length + 1);
  Module.HEAPU8.set(bytes, ptr);
  Module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

async function describeImage(imageBuffer) {
  const Module = await loadEngine();
  const { rgb, w, h } = await imageToRGB(imageBuffer);

  const rgbPtr = Module._malloc(rgb.length);
  const optsPtr = writeCString(Module, "{}");
  const outPtr = Module._malloc(OUT_CAPACITY);
  try {
    if (!rgbPtr || !outPtr) throw new Error("out of memory in describe");
    // Re-read HEAPU8 after every malloc — growing the heap swaps the buffer.
    Module.HEAPU8.set(rgb, rgbPtr);
    const code = Module._cactus_describe(
      rgbPtr,
      w,
      h,
      optsPtr,
      0,
      0,
      outPtr,
      OUT_CAPACITY,
    );
    if (code < 0) {
      const msg = Module.UTF8ToString(Module._cactus_last_error());
      throw new Error(msg || "cactus_describe failed");
    }
    const json = Module.UTF8ToString(outPtr);
    return JSON.parse(json);
  } finally {
    Module._free(rgbPtr);
    Module._free(optsPtr);
    Module._free(outPtr);
  }
}

// ────────────────────────────────────────────────────────── modes

const PORT = Number(process.env.CACTUS_PORT || 3002);

async function runServer() {
  // Pre-load the engine so the first request is fast.
  console.error(`[cactus] loading engine (first run takes a few seconds)…`);
  await loadEngine();

  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/describe") {
      const chunks = [];
      try {
        for await (const chunk of req) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "empty body" }));
        }
        const t0 = Date.now();
        const result = await describeImage(buffer);
        const dt = Date.now() - t0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...result, _ms: dt }, null, 2));
        console.error(
          `[cactus] described ${(buffer.length / 1024).toFixed(0)} KB → ${dt} ms`,
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        console.error(`[cactus] error: ${err.message}`);
      }
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: "ready" }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. POST an image to /describe, or GET /health.");
    }
  });
  server.listen(PORT, () => {
    console.error(`\nCactus describe service → http://localhost:${PORT}`);
    console.error(`  POST image bytes to /describe   → returns JSON`);
    console.error(`  GET  /health                    → status check`);
    console.error(`  Ctrl+C to stop\n`);
  });
}

async function runCLI(imagePath) {
  const buffer = await readFile(imagePath);
  const t0 = Date.now();
  const result = await describeImage(buffer);
  const dt = Date.now() - t0;
  console.log(JSON.stringify({ ...result, _ms: dt }, null, 2));
}

// ────────────────────────────────────────────────────────── entry

const arg = process.argv[2];
if (arg === "--serve") {
  runServer().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
} else if (arg) {
  runCLI(arg).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(`Usage:
  node cactus-node.mjs --serve              Run as HTTP service on :${PORT}
  node cactus-node.mjs <image.jpg>          One-shot describe, print JSON
`);
  process.exit(1);
}
