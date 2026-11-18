import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "perch-pi-selftest-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "session");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || "{}");
  const lastUser = [...(payload.messages || [])].reverse().find((message) => message.role === "user");
  const text = lastUser?.content && typeof lastUser.content === "string" ? lastUser.content : "hello";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const base = {
    id: "chatcmpl-perch",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
  };
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "PERCH PI OK" }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    mock: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "mock",
      models: [{
        id: "mock-model",
        name: "Mock Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}));

const child = spawn(process.execPath, [
  cli,
  "--mode", "rpc",
  "--session-dir", sessionDir,
  "--no-extensions",
  "--no-approve",
  "--model", "mock/mock-model",
  "--thinking", "off",
], {
  cwd: root,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let sequence = 0;
const pending = new Map();
const events = [];
let agentText = "";
let settled = false;

function send(command) {
  const id = `selftest-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${command.type}`)), 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "response" && pending.has(record.id)) {
      const pendingRequest = pending.get(record.id);
      clearTimeout(pendingRequest.timer);
      pending.delete(record.id);
      if (record.success === false) pendingRequest.reject(new Error(record.error));
      else pendingRequest.resolve(record.data);
      continue;
    }
    events.push(record.type);
    if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
      agentText += record.assistantMessageEvent.delta;
    }
    if (record.type === "message_end" && record.message?.role === "assistant") {
      agentText = (record.message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    if (record.type === "agent_settled") settled = true;
  }
});
child.stderr.setEncoding("utf8");
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const state = await send({ type: "get_state" });
  const prompt = await send({ type: "prompt", message: "Reply with PERCH PI OK" });
  const deadline = Date.now() + 20_000;
  while (!settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const messages = await send({ type: "get_messages" });
  const ok = agentText.includes("PERCH PI OK");
  console.log(JSON.stringify({
    ok,
    model: state.model,
    prompt,
    agentText,
    messageCount: messages.messages?.length ?? 0,
    events: [...new Set(events)],
    stderr: stderr.slice(-500),
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error), stderr: stderr.slice(-2000) }, null, 2));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(() => child.kill("SIGKILL"), 1500);
  });
  server.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* temp cleanup is best effort */
  }
}
