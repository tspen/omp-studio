import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const target = resolve("vendor/omp/omp.exe");
if (existsSync(target) && statSync(target).size > 50 * 1024 * 1024) {
  console.log(`OMP engine already present: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
  process.exit(0);
}

console.log("Fetching the latest OMP Windows x64 engine…");
const headers = { "user-agent": "OMP-Studio", accept: "application/vnd.github+json" };
let url = "https://github.com/can1357/oh-my-pi/releases/download/v18.20.0/omp-windows-x64.exe";
try {
  const response = await fetch("https://api.github.com/repos/can1357/oh-my-pi/releases/latest", { headers });
  if (response.ok) {
    const release = await response.json();
    const asset = release.assets?.find((item) => item.name === "omp-windows-x64.exe");
    if (asset?.browser_download_url) url = asset.browser_download_url;
  }
} catch {
  /* fall back to pinned release */
}

mkdirSync(dirname(target), { recursive: true });
const partial = `${target}.part`;
const response = await fetch(url, { headers: { "user-agent": "OMP-Studio" }, redirect: "follow" });
if (!response.ok || !response.body) throw new Error(`OMP download failed: HTTP ${response.status}`);
const total = Number(response.headers.get("content-length") || 0);
let received = 0;
let lastTick = 0;
const stream = Readable.fromWeb(response.body);
stream.on("data", (chunk) => {
  received += chunk.length;
  const now = Date.now();
  if (now - lastTick > 1000) {
    lastTick = now;
    const percent = total ? ((received / total) * 100).toFixed(1) : "?";
    process.stdout.write(`\r${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${percent}%)` : ""}`);
  }
});
await pipeline(stream, createWriteStream(partial));
if (existsSync(target)) unlinkSync(target);
renameSync(partial, target);
const size = statSync(target).size;
if (size < 50 * 1024 * 1024) throw new Error("Downloaded OMP engine is incomplete");
console.log(`\nSaved ${target} (${(size / 1024 / 1024).toFixed(1)} MB)`);
