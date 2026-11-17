#!/usr/bin/env node
/**
 * Remote execution performance gates.
 *
 *   node scripts/remote-perf.mjs --url http://127.0.0.1:43120 --token <token>
 *
 * It exercises the real HTTP API and WebSocket used by the phone, then cleans
 * up the imported copy through DELETE /api/nodes/:id. If the node is removed,
 * the next GC sweep reclaims its workspace and session directory.
 */
const url = arg("--url") || process.env.OMP_REMOTE_URL || "http://127.0.0.1:43120";
const token = arg("--token") || process.env.OMP_REMOTE_TOKEN || "";
const base = url.replace(/\/+$/, "");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function timed(label, runs, fn) {
  const samples = [];
  let value;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    value = await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const best = samples[0];
  console.log(`${label}: median ${median.toFixed(1)} ms, best ${best.toFixed(1)} ms (${runs} runs)`);
  return { median, best, value };
}

async function json(path, init) {
  const response = await fetch(`${base}${path}`, { headers, ...init });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

if (!token) {
  console.error("Pass --token or set OMP_REMOTE_TOKEN");
  process.exit(2);
}

const results = {};
results.health = await timed("health", 5, () => json("/api/health"));
results.state = await timed("state snapshot", 5, () => json("/api/state"));

const wsStarted = performance.now();
const wsLatency = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/events?token=${encodeURIComponent(token)}`);
  const timer = setTimeout(() => reject(new Error("WebSocket snapshot timed out")), 8_000);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "snapshot") return;
    clearTimeout(timer);
    socket.close();
    resolve({ latency: performance.now() - wsStarted, threads: message.payload.threads.length });
  };
  socket.onerror = () => reject(new Error("WebSocket failed"));
});
console.log(`websocket snapshot: ${wsLatency.latency.toFixed(1)} ms (${wsLatency.threads} threads)`);

const state = results.state.value;
const threadId = arg("--thread");
const thread = (threadId ? state.threads.find((item) => item.id === threadId) : state.threads.find((item) => item.kind === "worker")) || state.threads[0];
if (!thread) throw new Error("No session to move");
const exported = await timed("export bundle", 1, () => json(`/api/export/${thread.id}`));
const imported = await timed("cold move (export + import)", 3, async () => {
  const started = performance.now();
  const bundle = await json(`/api/export/${thread.id}`);
  const created = await json("/api/import", { method: "POST", body: JSON.stringify({ bundle: bundle.bundle }) });
  await json(`/api/nodes/${created.nodeId}`, { method: "DELETE" });
  return { ms: performance.now() - started, ...created };
});
const moved = imported.value;
console.log(`bundle size: ${(exported.value.bundle.length / 1024).toFixed(0)} KB (base64)`);
console.log(`moved + cleaned session node ${moved.nodeId}`);

const sweep = await json("/api/maintenance/sweep", { method: "POST", body: JSON.stringify({ dryRun: false }) });
console.log(`gc sweep: ${sweep.durationMs} ms, reclaimed ${(sweep.bytesReclaimed / 1024).toFixed(0)} KB across ${sweep.actions.length} item(s)`);
const after = await json("/api/state");
console.log(`sessions: ${state.threads.length} -> ${after.threads.length} after cleanup`);

const gates = [
  ["state snapshot", results.state.median, 500],
  ["websocket snapshot", wsLatency.latency, 500],
  ["cold move, small repo", imported.median, 5_000],
];
let ok = true;
for (const [label, value, gate] of gates) {
  const pass = value <= gate;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${value.toFixed(1)} ms (gate < ${gate} ms)`);
}
process.exit(ok ? 0 : 1);
