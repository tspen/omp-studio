import { app, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Environment, EnvVar } from "../../shared/types";
import type { Store } from "./store";

interface SecretFile {
  [envId: string]: { [key: string]: string };
}

const SECRET_PLACEHOLDER = "••••••••";

export class EnvironmentService {
  private store: Store;
  private secretsPath: string;
  private secrets: SecretFile = {};

  constructor(store: Store) {
    this.store = store;
    this.secretsPath = join(store.baseDir, "secrets.json");
  }

  init(): void {
    if (existsSync(this.secretsPath)) {
      try {
        this.secrets = JSON.parse(readFileSync(this.secretsPath, "utf8")) as SecretFile;
      } catch {
        this.secrets = {};
      }
    }
    if (this.store.environments.length === 0) {
      const now = Date.now();
      this.store.saveEnvironment({
        id: `env_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        name: "Local",
        envVars: [],
        setupCommands: [],
        teardownCommands: [],
        inheritEnv: true,
        gitMode: "auto",
        approvalMode: "write",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  list(): Environment[] {
    return this.store.environments.map((env) => this.mask(env));
  }

  get(id: string): Environment | undefined {
    const env = this.store.getEnvironment(id);
    return env ? this.mask(env) : undefined;
  }

  save(input: Environment): Environment {
    const existing = this.store.getEnvironment(input.id);
    const env: Environment = {
      ...input,
      envVars: (input.envVars ?? []).map((item) => {
        if (!item.secret) return { key: item.key, value: item.value, secret: false };
        const incoming = item.value && item.value !== SECRET_PLACEHOLDER ? item.value : "";
        if (incoming) this.setSecret(input.id, item.key, incoming);
        const hasSecret = !!this.getSecret(input.id, item.key) || !!item.hasSecret;
        return { key: item.key, value: "", secret: true, hasSecret };
      }),
      setupCommands: (input.setupCommands ?? []).filter((line) => line.trim()),
      teardownCommands: (input.teardownCommands ?? []).filter((line) => line.trim()),
      updatedAt: Date.now(),
    };
    if (!existing) env.createdAt = env.createdAt || Date.now();
    this.store.saveEnvironment(env);
    return this.mask(env);
  }

  remove(id: string): void {
    this.store.removeEnvironment(id);
    delete this.secrets[id];
    this.saveSecrets();
  }

  resolveForNode(nodeId: string): Environment | undefined {
    let current = this.store.getNode(nodeId);
    while (current) {
      if (current.environmentId) {
        const env = this.store.getEnvironment(current.environmentId);
        if (env) return env;
      }
      current = current.parentId ? this.store.getNode(current.parentId) : undefined;
    }
    return this.store.environments[0];
  }

  envForProcess(env: Environment | undefined): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = env?.inheritEnv === false ? {} : { ...process.env };
    if (!env) return merged;
    for (const item of env.envVars) {
      if (!item.key) continue;
      if (item.secret) {
        const secret = this.getSecret(env.id, item.key);
        if (secret !== undefined) merged[item.key] = secret;
      } else {
        merged[item.key] = item.value;
      }
    }
    merged.OMP_STUDIO_ENV_ID = env.id;
    return merged;
  }

  async test(id: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    const env = this.store.getEnvironment(id);
    if (!env) return { ok: false, output: "Environment not found" };
    const chunks: string[] = [];
    const commands = [...env.setupCommands, `echo OMP Studio environment "${env.name}" is ready`];
    const ok = await this.runCommands(env, commands, cwd, (text) => chunks.push(text));
    return { ok, output: chunks.join("") || "No commands configured." };
  }

  async runSetup(env: Environment | undefined, cwd: string, onOutput: (text: string) => void): Promise<boolean> {
    if (!env || env.setupCommands.length === 0) return true;
    return this.runCommands(env, env.setupCommands, cwd, onOutput);
  }

  async runTeardown(env: Environment | undefined, cwd: string, onOutput: (text: string) => void): Promise<boolean> {
    if (!env || env.teardownCommands.length === 0) return true;
    return this.runCommands(env, env.teardownCommands, cwd, onOutput);
  }

  private async runCommands(
    env: Environment,
    commands: string[],
    cwd: string,
    onOutput: (text: string) => void,
  ): Promise<boolean> {
    for (const command of commands) {
      const code = await this.runShell(command, cwd, this.envForProcess(env), onOutput);
      if (code !== 0) {
        onOutput(`\n[command failed: ${command}]\n`);
        return false;
      }
    }
    return true;
  }

  private runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, onOutput: (text: string) => void): Promise<number> {
    return new Promise((resolve) => {
      const isWindows = process.platform === "win32";
      const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
      const child = spawn(shell, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        onOutput(`\n[command timed out: ${command}]\n`);
        resolve(1);
      }, 300_000);
      child.stdout.on("data", (data: Buffer) => onOutput(data.toString()));
      child.stderr.on("data", (data: Buffer) => onOutput(data.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        onOutput(`${error.message}\n`);
        resolve(1);
      });
    });
  }

  private mask(env: Environment): Environment {
    return {
      ...env,
      envVars: env.envVars.map((item) =>
        item.secret
          ? { key: item.key, value: SECRET_PLACEHOLDER, secret: true, hasSecret: !!this.getSecret(env.id, item.key) }
          : { ...item },
      ),
    };
  }

  private getSecret(envId: string, key: string): string | undefined {
    const encoded = this.secrets[envId]?.[key];
    if (!encoded) return undefined;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(encoded, "base64"));
      }
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }

  private setSecret(envId: string, key: string, value: string): void {
    this.secrets[envId] ??= {};
    let encoded: string;
    if (safeStorage.isEncryptionAvailable()) {
      encoded = safeStorage.encryptString(value).toString("base64");
    } else {
      encoded = Buffer.from(value, "utf8").toString("base64");
    }
    this.secrets[envId][key] = encoded;
    this.saveSecrets();
  }

  private saveSecrets(): void {
    mkdirSync(join(this.secretsPath, ".."), { recursive: true });
    const tmp = `${this.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.secrets, null, 2), "utf8");
    renameSync(tmp, this.secretsPath);
  }
}

export { SECRET_PLACEHOLDER };
