import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { InstalledPlugin, PluginPreview } from "../../shared/types";
import type { SettingsService } from "./settings";
import type { Store } from "./store";

interface FoundPlugin {
  name: string;
  description?: string;
  path: string;
}

export class PluginService {
  private store: Store;
  private settings: SettingsService;
  private root: string;

  constructor(store: Store, settings: SettingsService) {
    this.store = store;
    this.settings = settings;
    this.root = join(store.baseDir, "plugins");
  }

  list(): InstalledPlugin[] {
    return this.store.plugins;
  }

  async preview(source: string): Promise<PluginPreview[]> {
    const prepared = await this.prepare(source);
    try {
      return prepared.plugins.map((plugin) => this.describe(plugin));
    } finally {
      prepared.cleanup();
    }
  }

  async install(source: string, name?: string): Promise<InstalledPlugin> {
    const prepared = await this.prepare(source);
    try {
      const plugin = name ? prepared.plugins.find((item) => item.name === name) : prepared.plugins.length === 1 ? prepared.plugins[0] : undefined;
      if (!plugin) {
        throw new Error(prepared.plugins.length > 1 ? `This marketplace has multiple plugins: ${prepared.plugins.map((item) => item.name).join(", ")}` : "No plugin found");
      }
      const dest = join(this.root, plugin.name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(this.root, { recursive: true });
      cpSync(plugin.path, dest, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".git") });
      const summary = this.describe(plugin);
      const skills = this.installSkills(plugin.name, dest);
      const commands = this.installCommands(plugin.name, dest);
      const mcpServers = this.installMcp(plugin.name, dest);
      const installed: InstalledPlugin = {
        name: plugin.name,
        source,
        path: dest,
        skills,
        mcpServers,
        commands,
        agents: summary.agents,
        hooks: summary.hooks,
        installedAt: Date.now(),
      };
      return this.store.addPlugin(installed);
    } finally {
      prepared.cleanup();
    }
  }

  remove(name: string): void {
    const plugin = this.store.plugins.find((item) => item.name === name);
    if (!plugin) return;
    for (const skill of plugin.skills) {
      const path = join(this.skillsRoot(), skill);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    for (const skill of this.commandSkills(plugin)) {
      const path = join(this.skillsRoot(), skill);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    for (const server of plugin.mcpServers) this.settings.removeMcpServer(server);
    if (existsSync(plugin.path)) rmSync(plugin.path, { recursive: true, force: true });
    this.store.removePlugin(name);
  }

  private async prepare(source: string): Promise<{ plugins: FoundPlugin[]; cleanup: () => void }> {
    const trimmed = source.trim();
    if (!trimmed) throw new Error("A Git URL or local plugin folder is required");
    if (/^https?:\/\/|^git@/i.test(trimmed)) {
      const dir = join(tmpdir(), `perch-plugin-${Date.now().toString(36)}`);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["clone", "--depth", "1", trimmed, dir], { windowsHide: true, timeout: 180_000, stdio: "pipe" });
      return { plugins: this.findPlugins(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
    const dir = resolve(trimmed);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("Plugin folder not found");
    return { plugins: this.findPlugins(dir), cleanup: () => undefined };
  }

  private findPlugins(root: string): FoundPlugin[] {
    const marketplacePath = join(root, ".claude-plugin", "marketplace.json");
    if (existsSync(marketplacePath)) {
      const data = JSON.parse(readFileSync(marketplacePath, "utf8")) as any;
      const plugins = (data.plugins ?? []) as any[];
      return plugins
        .map((item) => {
          const source = typeof item.source === "string" ? item.source : item.source?.path ?? "";
          const path = source ? resolve(root, source) : root;
          return { name: String(item.name ?? "").trim(), description: item.description, path };
        })
        .filter((item) => item.name && existsSync(item.path));
    }
    const manifestPath = [join(root, ".claude-plugin", "plugin.json"), join(root, "plugin.json")].find((path) => existsSync(path));
    if (!manifestPath) {
      const name = root.split(/[\\/]/).filter(Boolean).pop() ?? "plugin";
      return [{ name, path: root }];
    }
    const data = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
    return [{ name: String(data.name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? "plugin"), description: data.description, path: root }];
  }

  private describe(plugin: FoundPlugin): PluginPreview {
    const path = plugin.path;
    return {
      name: plugin.name,
      description: plugin.description,
      skills: countDirs(join(path, "skills")),
      commands: countFiles(join(path, "commands"), ".md"),
      agents: countFiles(join(path, "agents"), ".md"),
      hooks: countHooks(join(path, "hooks", "hooks.json")),
      mcpServers: Object.keys(readMcp(path)).length,
    };
  }

  private installSkills(plugin: string, root: string): string[] {
    const source = join(root, "skills");
    if (!existsSync(source)) return [];
    const installed: string[] = [];
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(source, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const name = `${plugin}--${entry.name}`;
      const dest = join(this.skillsRoot(), name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      cpSync(join(source, entry.name), dest, { recursive: true });
      installed.push(name);
    }
    return installed;
  }

  private installCommands(plugin: string, root: string): number {
    const source = join(root, "commands");
    if (!existsSync(source)) return 0;
    const files = readdirSync(source).filter((file) => file.toLowerCase().endsWith(".md"));
    for (const file of files) {
      const content = readFileSync(join(source, file), "utf8");
      const name = `${plugin}--cmd-${file.replace(/\.md$/i, "").replace(/[^a-z0-9_-]/gi, "-")}`;
      const dest = join(this.skillsRoot(), name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      const firstLine = content.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("---")) ?? file;
      writeFileSync(join(dest, "SKILL.md"), `---\nname: ${name}\ndescription: ${firstLine.replace(/^#+\s*/, "").slice(0, 200)}\n---\n\n${content}\n`, "utf8");
    }
    return files.length;
  }

  private installMcp(plugin: string, root: string): string[] {
    const servers = readMcp(root);
    const installed: string[] = [];
    for (const [name, config] of Object.entries(servers)) {
      const key = `${plugin}__${name}`;
      this.settings.addMcpServer(key, config as Record<string, unknown>);
      installed.push(key);
    }
    return installed;
  }

  private commandSkills(plugin: InstalledPlugin): string[] {
    const source = join(plugin.path, "commands");
    if (!existsSync(source)) return [];
    return readdirSync(source)
      .filter((file) => file.toLowerCase().endsWith(".md"))
      .map((file) => `${plugin.name}--cmd-${file.replace(/\.md$/i, "").replace(/[^a-z0-9_-]/gi, "-")}`);
  }

  private skillsRoot(): string {
    const root = join(process.env.USERPROFILE ?? "", "pi-agent", "skills");
    mkdirSync(root, { recursive: true });
    return root;
  }
}

function countDirs(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function countFiles(path: string, extension: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readdirSync(path).filter((file) => file.toLowerCase().endsWith(extension)).length;
  } catch {
    return 0;
  }
}

function countHooks(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as any;
    return Object.values(data.hooks ?? {}).reduce((sum: number, groups: any) => sum + (Array.isArray(groups) ? groups.length : 0), 0);
  } catch {
    return 0;
  }
}

function readMcp(root: string): Record<string, unknown> {
  for (const file of [join(root, ".mcp.json"), join(root, "mcp.json"), join(root, ".claude-plugin", "mcp.json")]) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as any;
      if (data?.mcpServers && typeof data.mcpServers === "object") return data.mcpServers;
    } catch {
      /* ignore */
    }
  }
  return {};
}
