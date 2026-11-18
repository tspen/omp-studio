/**
 * Perch host bridge for Pi.
 *
 * This file is written into the app data directory at runtime and loaded with
 * `pi --extension`. It exposes Perch's host tools to Pi and routes approval
 * prompts through Pi's RPC extension UI, which the desktop renders with the
 * same approval sheet as before.
 */
export const PI_HOST_EXTENSION = String.raw`
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}

export default function (pi) {
  const bridge = process.env.PERCH_BRIDGE_URL || "";
  const token = process.env.PERCH_BRIDGE_TOKEN || "";
  const specPath = process.env.PERCH_HOST_TOOLS || "";
  const approvalMode = (process.env.PERCH_APPROVAL_MODE || "yolo").toLowerCase();
  const policy = (() => {
    try { return JSON.parse(process.env.PERCH_TOOL_POLICY || "{}"); } catch { return {}; }
  })();
  const hostTools = (() => {
    if (!specPath) return [];
    try { return JSON.parse(readFileSync(specPath, "utf8")); } catch { return []; }
  })();
  const hostNames = new Set(hostTools.map((tool) => tool.name));

  async function callBridge(toolName, args, toolCallId) {
    if (!bridge || !token) throw new Error("Perch host bridge is not configured");
    const response = await fetch(bridge + "/tool", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ toolName, args, toolCallId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Host tool failed");
    return data.result ?? data;
  }

  for (const tool of hostTools) {
    const parameters = tool.parameters && Object.keys(tool.parameters).length
      ? tool.parameters
      : { type: "object", properties: {}, additionalProperties: true };
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters,
      async execute(toolCallId, params) {
        const result = await callBridge(tool.name, params || {}, toolCallId);
        if (result && Array.isArray(result.content)) {
          return { content: result.content, details: result.details || {}, isError: !!result.isError };
        }
        return {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
          details: {},
          isError: false,
        };
      },
    });
  }

  async function confirmTool(event, ctx) {
    let detail = "";
    try {
      detail = JSON.stringify(event.input || {});
    } catch {
      detail = String(event.input || "");
    }
    if (detail.length > 900) detail = detail.slice(0, 900) + "...";
    const ok = await ctx.ui.confirm("Allow " + event.toolName + "?", detail);
    return ok ? undefined : { block: true, reason: "Blocked by the user" };
  }

  pi.on("tool_call", async (event, ctx) => {
    const decision = policy[event.toolName];
    if (decision === "deny") return { block: true, reason: "This role cannot use " + event.toolName };
    if (decision === "allow" || hostNames.has(event.toolName)) return;
    if (decision === "prompt") return confirmTool(event, ctx);
    if (approvalMode === "yolo") return;

    const needsPrompt =
      approvalMode === "ask" ||
      approvalMode === "auto" && !["read", "grep", "find", "ls"].includes(event.toolName);
    if (!needsPrompt) return;
    return confirmTool(event, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const name = ctx.sessionManager && ctx.sessionManager.getSessionFile && ctx.sessionManager.getSessionFile();
    if (name && bridge && token) {
      await fetch(bridge + "/event", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ type: "session_start", sessionFile: name }),
      }).catch(() => undefined);
    }
  });
}
`;

