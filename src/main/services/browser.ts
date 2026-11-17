import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, WebContents } from "electron";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { AppEvent, BrowserConsoleEntry, BrowserNetworkEntry } from "../../shared/types";

const MAX_ENTRIES = 400;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(sequence++).toString(36)}`;

const LEVELS: BrowserConsoleEntry["level"][] = ["debug", "info", "warning", "error"];

export interface PickedElement {
  selector: string;
  text: string;
  tag: string;
}

export class BrowserController {
  private contents: WebContents | null = null;
  private waiter: ((contents: WebContents | null) => void) | null = null;
  private artifactsDir: string;
  private show: (url?: string) => void;
  private emit: (event: AppEvent) => void;
  private consoleEntries: BrowserConsoleEntry[] = [];
  private networkEntries: BrowserNetworkEntry[] = [];
  private networkSession: Session | null = null;
  private inFlight = new Map<number, { url: string; method: string; type: string; startedAt: number }>();

  constructor(artifactsDir: string, show: (url?: string) => void, emit: (event: AppEvent) => void = () => undefined) {
    this.artifactsDir = artifactsDir;
    this.show = show;
    this.emit = emit;
  }

  setContents(contents: WebContents | null): void {
    this.contents = contents;
    if (contents) {
      this.attachConsole(contents);
      this.attachNetwork(contents);
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(contents);
  }

  clearContents(contents: WebContents): void {
    if (this.contents === contents) {
      this.contents = null;
      this.waiter = null;
    }
  }

  isOpen(): boolean {
    return !!this.contents && !this.contents.isDestroyed();
  }

  history(): { console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[] } {
    return { console: [...this.consoleEntries], network: [...this.networkEntries] };
  }

  clearConsole(): void {
    this.consoleEntries = [];
  }

  clearNetwork(): void {
    this.networkEntries = [];
    this.inFlight.clear();
  }

  private attachConsole(contents: WebContents): void {
    if ((contents as any).__ompConsoleHooked) return;
    (contents as any).__ompConsoleHooked = true;
    contents.on("console-message", (first: any, legacyLevel?: any, legacyMessage?: any, legacyLine?: any, legacySource?: any) => {
      const modern = first && typeof first === "object" && ("message" in first || "level" in first) ? first : null;
      const rawLevel = modern ? modern.level : legacyLevel;
      const level = typeof rawLevel === "string"
        ? (LEVELS.includes(rawLevel as BrowserConsoleEntry["level"]) ? (rawLevel as BrowserConsoleEntry["level"]) : "info")
        : (LEVELS[Number(rawLevel)] ?? "info");
      const message = modern ? modern.message : legacyMessage;
      const sourceUrl = modern ? modern.sourceId : legacySource;
      const lineNumber = modern ? modern.lineNumber : legacyLine;
      const entry: BrowserConsoleEntry = {
        id: nextId("con"),
        level,
        message: String(message ?? "").slice(0, 4_000),
        source: sourceUrl ? String(sourceUrl) : undefined,
        line: Number.isFinite(lineNumber) ? Number(lineNumber) : undefined,
        timestamp: Date.now(),
      };
      this.pushConsole(entry);
    });
  }

  private attachNetwork(contents: WebContents): void {
    const session = contents.session;
    if (this.networkSession === session) return;
    this.networkSession = session;
    const matches = (details: any) =>
      !!this.contents &&
      !this.contents.isDestroyed() &&
      (!details.webContentsId || details.webContentsId === this.contents.id);

    session.webRequest.onBeforeRequest((details, callback) => {
      if (matches(details) && !/^(data|blob|devtools|chrome-extension):/i.test(details.url)) {
        if (this.inFlight.size > MAX_ENTRIES) {
          const oldest = this.inFlight.keys().next().value;
          if (oldest) this.inFlight.delete(oldest);
        }
        this.inFlight.set(details.id, {
          url: details.url,
          method: details.method,
          type: String(details.resourceType ?? "other"),
          startedAt: Date.now(),
        });
      }
      callback({});
    });

    session.webRequest.onCompleted((details) => {
      if (!matches(details)) return;
      const started = this.inFlight.get(details.id);
      this.inFlight.delete(details.id);
      const entry: BrowserNetworkEntry = {
        id: nextId("net"),
        url: details.url,
        method: started?.method ?? details.method,
        type: started?.type ?? String(details.resourceType ?? "other"),
        status: details.statusCode,
        ok: details.statusCode >= 200 && details.statusCode < 400,
        fromCache: !!details.fromCache,
        durationMs: started ? Date.now() - started.startedAt : undefined,
        timestamp: Date.now(),
      };
      this.pushNetwork(entry);
    });

    session.webRequest.onErrorOccurred((details) => {
      if (!matches(details)) return;
      const started = this.inFlight.get(details.id);
      this.inFlight.delete(details.id);
      const entry: BrowserNetworkEntry = {
        id: nextId("net"),
        url: details.url,
        method: started?.method ?? details.method,
        type: started?.type ?? String(details.resourceType ?? "other"),
        ok: false,
        failed: details.error || "Request failed",
        durationMs: started ? Date.now() - started.startedAt : undefined,
        timestamp: Date.now(),
      };
      this.pushNetwork(entry);
    });
  }

  private pushConsole(entry: BrowserConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_ENTRIES) this.consoleEntries.splice(0, this.consoleEntries.length - MAX_ENTRIES);
    this.emit({ type: "browser:console", payload: entry });
  }

  private pushNetwork(entry: BrowserNetworkEntry): void {
    this.networkEntries.push(entry);
    if (this.networkEntries.length > MAX_ENTRIES) this.networkEntries.splice(0, this.networkEntries.length - MAX_ENTRIES);
    this.emit({ type: "browser:network", payload: entry });
  }

  private async ensure(url?: string): Promise<WebContents> {
    if (this.contents && !this.contents.isDestroyed()) return this.contents;
    this.show(url);
    return new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("The in-app Browser panel did not open."));
      }, 10_000);
      this.waiter = (contents) => {
        clearTimeout(timer);
        if (contents) resolve(contents);
        else reject(new Error("The in-app Browser panel was closed."));
      };
    });
  }

  async navigate(url: string): Promise<string> {
    const contents = await this.ensure(url);
    await contents.loadURL(url);
    return contents.getURL();
  }

  async back(): Promise<void> {
    const contents = await this.ensure();
    const history = (contents as unknown as { navigationHistory?: { goBack?: () => void } }).navigationHistory;
    if (history?.goBack) history.goBack();
    else (contents as unknown as { goBack?: () => void }).goBack?.();
  }

  async forward(): Promise<void> {
    const contents = await this.ensure();
    const history = (contents as unknown as { navigationHistory?: { goForward?: () => void } }).navigationHistory;
    if (history?.goForward) history.goForward();
    else (contents as unknown as { goForward?: () => void }).goForward?.();
  }

  async reload(): Promise<void> {
    const contents = await this.ensure();
    contents.reload();
  }

  async screenshot(): Promise<string> {
    const contents = await this.ensure();
    const image = await contents.capturePage();
    const directory = join(this.artifactsDir, "browser");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `screenshot-${Date.now()}.png`);
    writeFileSync(path, image.toPNG());
    return path;
  }

  async compare(beforePath: string, afterPath: string): Promise<{ path: string; diffPixels: number; totalPixels: number; percent: number }> {
    const before = PNG.sync.read(readFileSync(beforePath));
    const after = PNG.sync.read(readFileSync(afterPath));
    const width = Math.min(before.width, after.width);
    const height = Math.min(before.height, after.height);
    if (!width || !height) throw new Error("Screenshots have no pixels");
    const size = width * height;
    const clippedBefore = clip(before, width, height);
    const clippedAfter = clip(after, width, height);
    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(clippedBefore.data, clippedAfter.data, diff.data, width, height, { threshold: 0.1 });
    const directory = join(this.artifactsDir, "browser");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `diff-${Date.now()}.png`);
    writeFileSync(path, PNG.sync.write(diff));
    return { path, diffPixels, totalPixels: size, percent: Math.round((diffPixels / size) * 10000) / 100 };
  }

  async read(): Promise<string> {    const contents = await this.ensure();
    const text = await contents.executeJavaScript("document.body ? document.body.innerText : ''", true);
    return String(text ?? "").slice(0, 20_000);
  }

  async click(selector: string): Promise<string> {
    const contents = await this.ensure();
    return String(
      await contents.executeJavaScript(
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return element.tagName.toLowerCase() + " clicked";
        })()`,
        true,
      ),
    );
  }

  async type(selector: string, text: string, submit: boolean): Promise<string> {
    const contents = await this.ensure();
    await contents.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
        if ("value" in element) {
          const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
          if (setter) setter.call(element, ${JSON.stringify(text)});
          else element.value = ${JSON.stringify(text)};
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(text)};
          element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }
        return true;
      })()`,
      true,
    );
    if (submit) {
      const submitted = await contents.executeJavaScript(
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (element && element.form && element.form.requestSubmit) { element.form.requestSubmit(); return true; }
          return false;
        })()`,
        true,
      );
      if (!submitted) {
        contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      }
    }
    return `Typed into ${selector}`;
  }

  async pickElement(): Promise<PickedElement | null> {
    const contents = await this.ensure();
    const script = `(() => new Promise((resolve) => {
      if (window.__ompPicker) { try { window.__ompPicker.cancel(); } catch (error) {} }
      const overlay = document.createElement("div");
      overlay.setAttribute("data-omp-picker", "overlay");
      overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c6cff;background:rgba(124,108,255,0.12);border-radius:4px;transition:none;display:none";
      const banner = document.createElement("div");
      banner.textContent = "Click an element to add it to the chat  ·  Esc to cancel";
      banner.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#1c1a2b;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,0.35)";
      let current = null;
      const cleanup = () => {
        overlay.remove();
        banner.remove();
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        if (window.__ompPicker) window.__ompPicker = null;
      };
      const finish = (value) => { cleanup(); resolve(value); };
      const selectorFor = (element) => {
        if (element.id) return "#" + CSS.escape(element.id);
        const parts = [];
        let node = element;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
          let part = node.tagName.toLowerCase();
          const classes = node.classList ? [...node.classList].filter((name) => /^[A-Za-z_-][\\w-]*$/.test(name) && !name.startsWith("css-")).slice(0, 2) : [];
          if (classes.length) part += "." + classes.map((name) => CSS.escape(name)).join(".");
          const parent = node.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
            if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
          }
          parts.unshift(part);
          const candidate = parts.join(" > ");
          try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (error) {}
          node = parent;
        }
        return parts.join(" > ");
      };
      const onMove = (event) => {
        const element = event.target;
        if (!element || element === overlay || element === banner) return;
        current = element;
        const rect = element.getBoundingClientRect();
        overlay.style.display = "block";
        overlay.style.left = rect.left + "px";
        overlay.style.top = rect.top + "px";
        overlay.style.width = rect.width + "px";
        overlay.style.height = rect.height + "px";
      };
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const element = event.target;
        if (!element) { finish(null); return; }
        const rect = element.getBoundingClientRect();
        finish({
          selector: selectorFor(element),
          text: String(element.innerText || element.getAttribute("aria-label") || element.getAttribute("alt") || "").trim().slice(0, 300),
          tag: element.tagName.toLowerCase(),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
      };
      const onKey = (event) => { if (event.key === "Escape") finish(null); };
      window.__ompPicker = { cancel: () => finish(null) };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      document.body.appendChild(banner);
      setTimeout(() => { if (window.__ompPicker) finish(null); }, 90000);
    }))()`;
    const picked = await contents.executeJavaScript(script, true);
    return picked && typeof picked === "object" ? (picked as PickedElement) : null;
  }
}

function clip(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) return source;
  const target = new PNG({ width, height });
  PNG.bitblt(source, target, 0, 0, width, height, 0, 0);
  return target;
}
