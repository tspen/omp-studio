import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { blake3 } from "hash-wasm";
import type { Site, SiteDeployment } from "../../shared/types";
import type { Store } from "./store";

const API = "https://api.cloudflare.com/client/v4";

export class DeployService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async deploy(siteId: string, provider: "cloudflare" | "github-pages"): Promise<SiteDeployment> {    const site = this.store.sites.find((item) => item.id === siteId);
    if (!site) throw new Error("Site not found");
    if (!site.currentVersion) throw new Error("Publish the site before deploying");
    const versionDir = join(this.store.baseDir, "sites", site.id, site.currentVersion);
    if (!existsSync(versionDir)) throw new Error("Published version files are missing; publish again");
    const deployment = provider === "cloudflare" ? await this.deployCloudflare(site, versionDir) : await this.deployGithubPages(site, versionDir);
    const deployments = [deployment, ...(site.deployments ?? [])].slice(0, 12);
    this.store.updateSite(site.id, { deployments });
    return deployment;
  }

  async addCloudflareDomain(siteId: string, domain: string): Promise<{ ok: boolean; output: string; url?: string }> {    const site = this.store.sites.find((item) => item.id === siteId);
    if (!site) throw new Error("Site not found");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error("Enter a valid domain name");
    const token = this.store.getSecret("cloudflare.token") || process.env.CLOUDFLARE_API_TOKEN || "";
    const accountId = this.store.settings.connectors.cloudflare.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    const project = (this.store.settings.connectors.cloudflare.projectName || site.name).replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
    if (!token || !accountId) throw new Error("Add a Cloudflare API token and account ID first");
    const response = await fetch(`${API}/accounts/${accountId}/pages/projects/${project}/domains`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: domain }),
    });
    const payload = (await response.json().catch(() => ({}))) as any;
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare domain failed: ${describe(payload)}`);
    return { ok: true, output: `Domain ${domain} added to ${project}. Point DNS at the Pages project if it is not on this Cloudflare account.`, url: `https://${domain}/` };
  }

  async configureCloudflareAccess(siteId: string, domain: string, emails: string[]): Promise<{ ok: boolean; output: string }> {
    const site = this.store.sites.find((item) => item.id === siteId);
    if (!site) throw new Error("Site not found");
    const token = this.store.getSecret("cloudflare.token") || process.env.CLOUDFLARE_API_TOKEN || "";
    const accountId = this.store.settings.connectors.cloudflare.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    if (!token || !accountId) throw new Error("Add a Cloudflare API token and account ID first");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error("A valid custom domain is required before Access can be configured");
    const allowed = emails.map((email) => email.trim()).filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
    if (!allowed.length) throw new Error("Add at least one allowed email address");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const appsResponse = await fetch(`${API}/accounts/${accountId}/access/apps?per_page=100`, { headers });
    const appsPayload = (await appsResponse.json().catch(() => ({}))) as any;
    if (!appsResponse.ok) throw new Error(`Cloudflare Access lookup failed: ${describe(appsPayload)}`);
    let app = (appsPayload.result ?? []).find((item: any) => String(item.domain ?? "").toLowerCase() === domain.toLowerCase());
    if (!app) {
      const created = await fetch(`${API}/accounts/${accountId}/access/apps`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: `${site.name} (Perch)`,
          domain,
          type: "self_hosted",
          session_duration: "24h",
        }),
      });
      const createdPayload = (await created.json().catch(() => ({}))) as any;
      if (!created.ok || createdPayload.success === false) throw new Error(`Cloudflare Access app failed: ${describe(createdPayload)}`);
      app = createdPayload.result;
    }
    const appId = app?.id ?? app?.uid;
    if (!appId) throw new Error("Cloudflare Access did not return an application id");
    const policiesResponse = await fetch(`${API}/accounts/${accountId}/access/apps/${appId}/policies?per_page=100`, { headers });
    const policiesPayload = (await policiesResponse.json().catch(() => ({}))) as any;
    const existing = (policiesPayload.result ?? []) as any[];
    const alreadyAllows = existing.some((policy) => policy.decision === "allow");
    if (!alreadyAllows) {
      const policy = await fetch(`${API}/accounts/${accountId}/access/apps/${appId}/policies`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Perch allow list",
          decision: "allow",
          include: allowed.map((email) => ({ email: { email } })),
        }),
      });
      const policyPayload = (await policy.json().catch(() => ({}))) as any;
      if (!policy.ok || policyPayload.success === false) throw new Error(`Cloudflare Access policy failed: ${describe(policyPayload)}`);
    }
    return {
      ok: true,
      output: `Cloudflare Access protects https://${domain} for ${allowed.join(", ")}.${alreadyAllows ? " Existing allow policy kept." : ""} Configure an identity provider in Zero Trust if you have not already.`,
    };
  }

  private async deployCloudflare(site: Site, versionDir: string): Promise<SiteDeployment> {
    const token = this.store.getSecret("cloudflare.token") || process.env.CLOUDFLARE_API_TOKEN || "";
    const accountId = this.store.settings.connectors.cloudflare.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    const branch = this.store.settings.connectors.cloudflare.branch || "main";
    const project = (this.store.settings.connectors.cloudflare.projectName || slug(site.name)).replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
    if (!token) throw new Error("Add a Cloudflare API token in Settings → Connectors");
    if (!accountId) throw new Error("Add your Cloudflare account ID in Settings → Connectors");

    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const existing = await fetch(`${API}/accounts/${accountId}/pages/projects/${project}`, { headers });
    if (existing.status === 404) {
      const created = await fetch(`${API}/accounts/${accountId}/pages/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: project, production_branch: branch }),
      });
      const payload = (await created.json().catch(() => ({}))) as any;
      if (!created.ok || payload.success === false) {
        throw new Error(`Cloudflare project create failed: ${describe(payload)}`);
      }
    } else if (!existing.ok) {
      const payload = (await existing.json().catch(() => ({}))) as any;
      throw new Error(`Cloudflare project lookup failed: ${describe(payload)}`);
    }

    const files = walk(versionDir);
    if (!files.length) throw new Error("No files to deploy");
    const entries: Array<{ path: string; hash: string; data: Buffer; contentType: string }> = [];
    for (const file of files) {
      const data = readFileSync(join(versionDir, file));
      const extension = extname(file).replace(/^\./, "");
      const hash = (await blake3(new Uint8Array(Buffer.concat([data, Buffer.from(extension)])))).slice(0, 32);
      entries.push({ path: file.replace(/\\/g, "/"), hash, data, contentType: mime(file) });
    }
    const unique = new Map<string, { hash: string; data: Buffer; contentType: string }>();
    for (const entry of entries) if (!unique.has(entry.hash)) unique.set(entry.hash, entry);

    const tokenResponse = await fetch(`${API}/accounts/${accountId}/pages/projects/${project}/upload-token`, { headers });
    const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as any;
    if (!tokenResponse.ok) throw new Error(`Cloudflare upload token failed: ${describe(tokenPayload)}`);
    const jwt = tokenPayload.result?.jwt;
    if (!jwt) throw new Error("Cloudflare did not return an upload token");

    const batches: Array<Array<{ key: string; value: string; metadata: { contentType: string }; base64: boolean }>> = [];
    let batch: typeof batches[number] = [];
    let size = 0;
    for (const [hash, entry] of unique) {
      const value = entry.data.toString("base64");
      batch.push({ key: hash, value, metadata: { contentType: entry.contentType }, base64: true });
      size += value.length;
      if (size > 12_000_000) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
    }
    if (batch.length) batches.push(batch);

    for (const chunk of batches) {
      const upload = await fetch(`${API}/pages/assets/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!upload.ok) {
        const payload = (await upload.json().catch(() => ({}))) as any;
        throw new Error(`Cloudflare asset upload failed: ${describe(payload)}`);
      }
    }

    const manifest = Object.fromEntries(entries.map((entry) => [entry.path, entry.hash]));
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", branch);
    form.append("commit_message", `Perch deploy ${new Date().toISOString()}`);
    const deployment = await fetch(`${API}/accounts/${accountId}/pages/projects/${project}/deployments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = (await deployment.json().catch(() => ({}))) as any;
    if (!deployment.ok || payload.success === false) {
      throw new Error(`Cloudflare deployment failed: ${describe(payload)}`);
    }
    const url = payload.result?.url as string | undefined;
    return {
      id: payload.result?.id ?? `dep_${Date.now().toString(36)}`,
      provider: "cloudflare",
      url,
      project,
      branch,
      status: "success",
      detail: `${entries.length} files · ${new Set(entries.map((entry) => entry.hash)).size} unique`,
      createdAt: Date.now(),
    };
  }

  private async deployGithubPages(site: Site, versionDir: string): Promise<SiteDeployment> {
    const node = this.store.getNode(site.nodeId);
    const cwd = node?.repoPath || node?.path;
    if (!cwd) throw new Error("Project folder not found");
    let remote = "";
    try {
      remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", windowsHide: true }).trim();
    } catch {
      throw new Error("This project has no GitHub origin remote");
    }
    const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i.exec(remote);
    if (!match) throw new Error("Origin is not a GitHub repository");
    const [, owner, repo] = match;
    let token = this.store.getSecret("github.token") || process.env.GITHUB_TOKEN || "";
    if (!token) {
      try {
        token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).trim();
      } catch {
        token = "";
      }
    }
    const temp = mkdtempSync(join(tmpdir(), "perch-pages-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: temp, windowsHide: true });
      execFileSync("git", ["checkout", "-q", "-b", "gh-pages"], { cwd: temp, windowsHide: true });
      copyTree(versionDir, temp);
      execFileSync("git", ["add", "-A"], { cwd: temp, windowsHide: true });
      execFileSync("git", ["-c", "user.name=Perch", "-c", "user.email=studio@local", "commit", "-qm", `Deploy ${site.name}`], { cwd: temp, windowsHide: true });
      const url = token
        ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
        : remote;
      execFileSync("git", ["push", "-f", url, "HEAD:gh-pages"], {
        cwd: temp,
        windowsHide: true,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PRPerchT: "0" },
        timeout: 300_000,
      });
      if (token) {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/pages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
          body: JSON.stringify({ source: { branch: "gh-pages", path: "/" } }),
        }).catch(() => undefined);
      }
      return {
        id: `dep_${Date.now().toString(36)}`,
        provider: "github-pages",
        url: `https://${owner}.github.io/${repo}/`,
        project: `${owner}/${repo}`,
        branch: "gh-pages",
        status: "success",
        detail: "Pushed gh-pages branch",
        createdAt: Date.now(),
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `site-${Date.now().toString(36)}`;
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  visit(root);
  return files.sort();
}

function copyTree(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

function mime(path: string): string {
  const extension = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return map[extension] ?? "application/octet-stream";
}

function describe(payload: any): string {
  if (!payload) return "unknown error";
  if (Array.isArray(payload.errors) && payload.errors.length) return payload.errors.map((error: any) => error.message).join("; ");
  return payload.message || JSON.stringify(payload).slice(0, 400);
}
