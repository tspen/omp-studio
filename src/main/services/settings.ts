import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type { McpServerInfo, PiConfigEntry, PiConfigSnapshot, SkillInfo, ToolApproval, ToolInfo } from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import type { Store } from "./store";

const TOOL_KEYS: Record<string, string> = {
  bash: "bash.enabled",
  read: "",
  edit: "",
  write: "",
  grep: "grep.enabled",
  glob: "glob.enabled",
  lsp: "lsp.enabled",
  task: "",
  todo: "todo.enabled",
  web_search: "web_search.enabled",
  browser: "browser.enabled",
  inspect_image: "inspect_image.enabled",
  computer: "computer.enabled",
  generate_image: "generate_image.enabled",
  tts: "speechgen.enabled",
  github: "github.enabled",
  checkpoint: "checkpoint.enabled",
  debug: "debug.enabled",
  launch: "launch.enabled",
  security: "security.enabled",
  ast_grep: "astGrep.enabled",
  ast_edit: "astEdit.enabled",
  python: "eval.py",
  notebook: "",
  ask: "ask.enabled",
  goal: "goal.enabled",
  plan: "plan.enabled",
  debug_tool: "debug.enabled",
};

const PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const PI_SETTING_DESCRIPTIONS: Record<string, string> = {
  "defaultModel": "Model selector used for new sessions.",
  "defaultThinkingLevel": "Thinking level used for new sessions.",
  "theme": "Terminal theme name.",
  "compaction.enabled": "Automatically summarize history when the context window fills.",
  "retry.maxRetries": "Retries for transient provider failures.",
  "tools": "Default tool allowlist.",
  "packages": "Installed Pi packages.",
  "extensions": "Installed Pi extensions.",
  "skills": "Installed Pi skills.",
  "sessionDir": "Directory for Pi session files.",
};

function setPath(target: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object" || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

function deletePath(target: Record<string, any>, key: string): void {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") return;
    node = node[part];
  }
  delete node[parts[parts.length - 1]];
}
const HOST_TOOLS = [
  "tree_list",
  "tree_create_node",
  "tree_create_thread",
  "tree_message",
  "tree_ask_parent",
  "tree_report",
  "tree_reply",
  "tree_wait",
  "tree_cancel",
  "tree_resolve_thread",
  "tree_git",
  "tree_memory_write",
  "tree_memory_read",
  "tree_set_title",
  "tree_update_node",
  "tree_move_node",
  "tree_delete_node",
  "tree_create_environment",
  "tree_update_environment",
  "tree_assign_environment",
  "tree_list_environments",
  "tree_test_environment",
  "lsp",
  "launch",
  "debug",
  "ast_grep",
  "ast_edit",
  "web_search",
  "task",
  "workspace_search",
  "workspace_map",
  "python",
  "notebook",
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_keys",
  "mobile_devices",
  "mobile_start_avd",
  "mobile_screenshot",
  "mobile_tap",
  "mobile_text",
  "mobile_key",
  "site_list",
  "site_create",
  "site_publish",
  "site_deploy",
  "dev_server_start",
  "dev_server_stop",
  "dev_server_list",
  "app_browser_navigate",
  "app_browser_console",
  "app_browser_network",
  "app_browser_read",
  "app_browser_click",
  "app_browser_type",
  "app_browser_back",
  "app_browser_forward",
  "app_browser_reload",
  "app_browser_screenshot",
  "app_browser_visual_diff",
];

export class SettingsService {
  private store: Store;
  private engine: EngineLocator;

  constructor(store: Store, engine: EngineLocator) {
    this.store = store;
    this.engine = engine;
  }

  configFile(): string {
    return join(this.store.baseDir, "pi-agent", "settings.json");
  }

  private readSettings(): Record<string, any> {
    const path = this.configFile();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    } catch {
      return {};
    }
  }

  async refresh(): Promise<PiConfigSnapshot> {
    const path = this.configFile();
    const entries: PiConfigEntry[] = [];
    let error: string | undefined;
    try {
      const parsed = this.readSettings();
      const walk = (value: Record<string, any>, prefix: string) => {
        for (const [key, item] of Object.entries(value ?? {})) {
          const full = prefix ? prefix + "." + key : key;
          if (item && typeof item === "object" && !Array.isArray(item) && full.split(".").length < 2) {
            walk(item as Record<string, any>, full);
          } else {
            entries.push({
              key: full,
              value: item,
              type: normalizeType(typeof item),
              description: PI_SETTING_DESCRIPTIONS[full] ?? "",
              group: full.split(".")[0] || "other",
            });
          }
        }
      };
      walk(parsed, "");
    } catch (parseError) {
      error = "Could not parse Pi settings: " + String(parseError);
    }
    const snapshot: PiConfigSnapshot = { path, entries, fetchedAt: Date.now(), error };
    this.store.setConfig(snapshot);
    return snapshot;
  }

  async set(key: string, value: unknown): Promise<PiConfigSnapshot> {
    const data = this.readSettings();
    setPath(data, key, value);
    mkdirSync(join(this.configFile(), ".."), { recursive: true });
    writeFileSync(this.configFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
    return this.refresh();
  }

  async reset(key: string): Promise<PiConfigSnapshot> {
    const data = this.readSettings();
    deletePath(data, key);
    mkdirSync(join(this.configFile(), ".."), { recursive: true });
    writeFileSync(this.configFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
    return this.refresh();
  }

  async readRaw(): Promise<{ path: string; yaml: string; parsed: unknown }> {
    const path = this.configFile();
    if (!existsSync(path)) return { path, yaml: "{}\n", parsed: {} };
    const parsed = this.readSettings();
    return { path, yaml: JSON.stringify(parsed, null, 2) + "\n", parsed };
  }

  async writeRaw(raw: string): Promise<PiConfigSnapshot> {
    const path = this.configFile();
    const parsed = JSON.parse(raw || "{}");
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path)) writeFileSync(path + ".backup-" + Date.now(), readFileSync(path));
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    return this.refresh();
  }

  tools(): ToolInfo[] {
    const overrides = this.store.settings.perchTools ?? {};
    const tools: ToolInfo[] = [];
    for (const name of PI_TOOLS) {
      const override = overrides[name];
      tools.push({
        name,
        label: labelFor(name),
        description: descriptionFor(name),
        enabled: override?.enabled !== false,
        approval: override?.approval ?? "allow",
        configKey: name,
        group: groupFor(name),
        source: "pi",
      });
    }
    for (const name of HOST_TOOLS) {
      tools.push({
        name,
        label: labelFor(name),
        description: descriptionFor(name),
        enabled: true,
        approval: "allow",
        group: groupFor(name),
        source: "host",
      });
    }
    return tools;
  }

  async setTool(name: string, enabled: boolean, approval?: ToolApproval): Promise<ToolInfo[]> {
    const current = { ...(this.store.settings.perchTools ?? {}) };
    const previous = current[name];
    current[name] = { enabled, approval: approval ?? previous?.approval ?? "allow" };
    this.store.setSettings({ perchTools: current });
    return this.tools();
  }

  skills(): SkillInfo[] {
    const roots = [
      join(this.store.baseDir, "pi-agent", "skills"),
      join(process.env.USERPROFILE ?? "", ".claude", "skills"),
    ];
    const skills: SkillInfo[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        for (const name of readdirSync(root)) {
          const path = join(root, name);
          try {
            if (!statSync(path).isDirectory()) continue;
          } catch {
            continue;
          }
          const skillFile = join(path, "SKILL.md");
          let description = "";
          if (existsSync(skillFile)) {
            const text = readFileSync(skillFile, "utf8");
            description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
          }
          skills.push({ name, path, description, enabled: true, source: root.includes(".claude") ? "claude" : "pi" });
        }
      } catch {
        /* ignore */
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  mcpServers(): McpServerInfo[] {
    const files = [
      { path: join(this.store.baseDir, "pi-agent", "mcp.json"), source: "user" },
      { path: join(this.store.baseDir, "pi-agent", "mcp.json"), source: "user" },
    ];
    const byName = new Map<string, McpServerInfo>();
    for (const file of files) {
      if (!existsSync(file.path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(file.path, "utf8")) as any;
        const servers = parsed?.mcpServers ?? parsed?.servers ?? parsed;
        for (const [name, value] of Object.entries(servers ?? {})) {
          const config = value as any;
          if (!config || typeof config !== "object") continue;
          byName.set(name, {
            name,
            command: config.command ? [config.command, ...(config.args ?? [])].join(" ") : undefined,
            url: config.url,
            enabled: config.enabled !== false && config.disabled !== true,
            source: file.source,
          });
        }
      } catch {
        /* ignore malformed config */
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  createSkill(input: { name: string; description: string; body: string }): SkillInfo {
    const slug = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    if (!slug) throw new Error("Skill name is required");
    const root = join(this.store.baseDir, "pi-agent", "skills");
    const path = join(root, slug);
    mkdirSync(path, { recursive: true });
    const description = input.description.trim() || input.name.trim();
    const content = `---\nname: ${input.name.trim()}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`;
    writeFileSync(join(path, "SKILL.md"), content, "utf8");
    return { name: slug, path, description, enabled: true, source: "pi" };
  }

  readSkill(path: string): { content: string; path: string } {
    for (const root of this.skillRoots()) {
      if (!isInside(root, path)) continue;
      const file = join(path, "SKILL.md");
      if (existsSync(file)) return { content: readFileSync(file, "utf8"), path: file };
    }
    throw new Error("Skill not found in a managed skills folder");
  }

  saveSkill(path: string, content: string): void {
    for (const root of this.skillRoots()) {
      if (!isInside(root, path)) continue;
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "SKILL.md"), content, "utf8");
      return;
    }
    throw new Error("Skill not found in a managed skills folder");
  }

  deleteSkill(path: string): void {
    for (const root of this.skillRoots()) {
      if (!isInside(root, path)) continue;
      rmSync(path, { recursive: true, force: true });
      return;
    }
    throw new Error("Only skills in managed Pi/Claude skill folders can be deleted");
  }

  mcpConfigPath(): string {
    return join(this.store.baseDir, "pi-agent", "mcp.json");
  }

  addMcpServer(name: string, config: Record<string, unknown>): McpServerInfo[] {
    const path = this.mcpConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    let data: any = {};
    if (existsSync(path)) {
      try {
        data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        data = {};
      }
    }
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[name] = config;
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return this.mcpServers();
  }

  removeMcpServer(name: string): McpServerInfo[] {
    const path = this.mcpConfigPath();
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        if (data?.mcpServers?.[name]) {
          delete data.mcpServers[name];
          writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        }
      } catch {
        /* ignore malformed config */
      }
    }
    return this.mcpServers();
  }

  importAgentConfigs(): { imported: string[]; path: string } {
    const home = process.env.USERPROFILE ?? "";
    const candidates: Array<{ path: string; key?: string }> = [
      { path: join(home, ".claude.json") },
      { path: join(home, ".claude", "mcp.json") },
      { path: join(home, ".claude", "settings.json"), key: "mcpServers" },
    ];
    const imported: string[] = [];
    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) continue;
      try {
        const data = JSON.parse(readFileSync(candidate.path, "utf8"));
        const servers = candidate.key ? data?.[candidate.key] : data?.mcpServers ?? data?.servers;
        for (const [name, value] of Object.entries(servers ?? {})) {
          if (!value || typeof value !== "object") continue;
          const config = value as any;
          if (!config.url && !config.command) continue;
          this.addMcpServer(name, config);
          imported.push(name);
        }
      } catch {
        /* ignore malformed config */
      }
    }
    const codex = join(home, ".codex", "config.toml");
    if (existsSync(codex)) {
      try {
        const text = readFileSync(codex, "utf8");
        const blocks = text.split(/^\[\[?mcp_servers\.([^\]]+)\]\]?/m).slice(1);
        for (let index = 0; index < blocks.length; index += 2) {
          const name = blocks[index].replace(/["']/g, "").trim();
          const body = blocks[index + 1] ?? "";
          const url = body.match(/^\s*(?:url|serverUrl)\s*=\s*["']([^"']+)["']/m)?.[1];
          const command = body.match(/^\s*command\s*=\s*["']([^"']+)["']/m)?.[1];
          if (!name || (!url && !command)) continue;
          this.addMcpServer(name, url ? { type: "http", url } : { command });
          imported.push(name);
        }
      } catch {
        /* ignore malformed TOML */
      }
    }
    return { imported: [...new Set(imported)], path: this.mcpConfigPath() };
  }

  private skillRoots(): string[] {
    return [
      join(this.store.baseDir, "pi-agent", "skills"),
      join(process.env.USERPROFILE ?? "", ".claude", "skills"),
    ];
  }
}

function normalizeType(type: string): PiConfigEntry["type"] {
  if (["boolean", "number", "string", "enum", "array", "record"].includes(type)) return type as PiConfigEntry["type"];
  return "unknown";
}

function labelFor(name: string): string {
  return name
    .replace(/^tree_/, "Tree: ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (chars) => chars.toUpperCase());
}

function groupFor(name: string): string {
  if (name.startsWith("tree_")) return "Tree protocol";
  if (["read", "edit", "write", "grep", "glob", "ast_grep", "ast_edit", "notebook"].includes(name)) return "Files";
  if (["bash", "python", "eval", "debug", "launch"].includes(name)) return "Execution";
  if (["web_search", "browser", "github", "computer", "inspect_image", "generate_image", "tts"].includes(name)) return "External";
  if (["lsp", "task", "todo", "ask", "goal", "plan", "checkpoint", "security"].includes(name)) return "Agent";
  return "Other";
}

function descriptionFor(name: string): string {
  const map: Record<string, string> = {
    read: "Read file contents and URLs.",
    bash: "Execute shell commands.",
    edit: "Edit files with find/replace.",
    write: "Create and overwrite files.",
    grep: "Search file contents.",
    glob: "Find files by glob.",
    lsp: "Language-server code intelligence.",
    launch: "Start a DAP debug session.",
    debug: "Control the active DAP debug session.",
    ast_grep: "Search code structurally across bundled languages.",
    ast_edit: "Rewrite code structurally across bundled languages.",
    web_search: "Search the web through the configured provider.",
    task: "Spawn worker sessions for parallel work.",
    todo: "Maintain a todo list.",
    python: "Execute Python code in a persistent kernel.",
    notebook: "Read and run Jupyter notebook cells.",
    browser: "Automate a Chromium browser.",
    ask: "Ask the user a question.",
    goal: "Goal mode.",
    plan: "Plan mode.",
  };
  return map[name] ?? "Pi tool.";
}

function run(exe: string, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? (error ? error.message : ""),
        });
      },
    );
  });
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const path = resolve(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}


