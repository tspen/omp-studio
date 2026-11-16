import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";

export class BrowserController {
  private contents: WebContents | null = null;
  private waiter: ((contents: WebContents | null) => void) | null = null;
  private artifactsDir: string;
  private show: (url?: string) => void;

  constructor(artifactsDir: string, show: (url?: string) => void) {
    this.artifactsDir = artifactsDir;
    this.show = show;
  }

  setContents(contents: WebContents | null): void {
    this.contents = contents;
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

  async read(): Promise<string> {
    const contents = await this.ensure();
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
}
