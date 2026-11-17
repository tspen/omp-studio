import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MobileDevice } from "../../shared/types";

export class MobileService {
  private artifactsDir: string;

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  available(): { adb: boolean; emulator: boolean } {
    return { adb: this.which("adb"), emulator: this.which("emulator") };
  }

  devices(): MobileDevice[] {
    if (!this.available().adb) return [];
    try {
      const output = execFileSync("adb", ["devices", "-l"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      return output
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          const serial = parts[0];
          const state = parts[1] ?? "unknown";
          const model = /model:([^\s]+)/.exec(line)?.[1]?.replace(/_/g, " ");
          return { serial, state, model };
        })
        .filter((device) => device.serial && !device.serial.startsWith("*"));
    } catch {
      return [];
    }
  }

  avds(): string[] {
    if (!this.available().emulator) return [];
    try {
      return execFileSync("emulator", ["-list-avds"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  startAvd(name: string): void {
    if (!/^[\w .()-]+$/.test(name)) throw new Error("Invalid AVD name");
    const child = spawn("emulator", ["-avd", name], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  }

  private serial(device?: string): string {
    if (device) return device;
    const first = this.devices().find((item) => item.state === "device");
    if (!first) throw new Error("No running Android device. Start an emulator or connect a device.");
    return first.serial;
  }

  async screenshot(device?: string): Promise<string> {
    const serial = this.serial(device);
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      execFile("adb", ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as unknown as Buffer);
      });
    });
    const directory = join(this.artifactsDir, "android");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `android-${Date.now()}.png`);
    writeFileSync(path, buffer);
    return path;
  }

  tap(device: string | undefined, x: number, y: number): string {
    this.shell(device, ["input", "tap", String(Math.round(x)), String(Math.round(y))]);
    return `Tapped ${Math.round(x)},${Math.round(y)}`;
  }

  text(device: string | undefined, text: string): string {
    this.shell(device, ["input", "text", text.replace(/\s/g, "%s")]);
    return `Typed ${text.length} characters`;
  }

  key(device: string | undefined, key: string): string {
    const code = /^\d+$/.test(key) ? key : key.toUpperCase().replace(/^KEYCODE_/, "");
    this.shell(device, ["input", "keyevent", code]);
    return `Sent key ${code}`;
  }

  swipe(device: string | undefined, x1: number, y1: number, x2: number, y2: number, durationMs = 300): string {
    this.shell(device, ["input", "swipe", String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))]);
    return "Swiped";
  }

  private shell(device: string | undefined, args: string[]): void {
    execFileSync("adb", ["-s", this.serial(device), "shell", ...args], { windowsHide: true, timeout: 20_000, stdio: "ignore" });
  }

  private which(exe: string): boolean {
    try {
      execFileSync("where.exe", [exe], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
}
