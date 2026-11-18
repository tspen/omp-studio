import { createServer } from "node:http";

const port = Number(process.env.PERCH_MOCK_PORT || 45123);
const text = process.env.PERCH_MOCK_TEXT || "PERCH PI OK";

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || "{}");
  const messages = payload.messages || [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const contentText = (content) => typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join(" ")
      : "";
  const userText = contentText(lastUser?.content) || "hello";
  const hasToolResult = messages.some((message) => message.role === "tool");
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const base = {
    id: "chatcmpl-perch-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
  };
  if (/task test/i.test(userText) && !hasToolResult) {
    const toolCall = { tasks: [{ brief: "Reply with WORKER OK", title: "Worker task" }] };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_task_1", type: "function", function: { name: "task", arguments: "" } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall) } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  if (/host tool test/i.test(userText) && !hasToolResult) {
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_host_1", type: "function", function: { name: "tree_list", arguments: "" } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  const reply = hasToolResult ? "TASK DONE" : (/WORKER OK/i.test(userText) ? "WORKER OK" : /perch pi ok/i.test(userText) ? "PERCH PI OK" : text);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Perch mock provider listening on http://127.0.0.1:${port}/v1`);
});

