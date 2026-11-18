import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const MOUSE = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PerchMouse{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,uint e);}'`;

export class ComputerService {
  private artifactsDir: string;

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  private run(command: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { windowsHide: true, timeout: 30_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, output: (stdout || stderr || error?.message || "").trim() }),
      );
    });
  }

  async screenshot(): Promise<string> {
    if (process.platform !== "win32") throw new Error("Computer use is Windows-only");
    const directory = join(this.artifactsDir, "desktop");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `desktop-${Date.now()}.png`);
    const escaped = path.replace(/'/g, "''");
    const result = await this.run(
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${escaped}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); Write-Output '${escaped}'`,
    );
    if (!result.ok) throw new Error(`Screenshot failed: ${result.output}`);
    return path;
  }

  async click(x: number, y: number, button: "left" | "right" = "left"): Promise<string> {
    if (process.platform !== "win32") throw new Error("Computer use is Windows-only");
    const down = button === "right" ? "0x08" : "0x02";
    const up = button === "right" ? "0x10" : "0x04";
    const result = await this.run(`${MOUSE}; [PerchMouse]::SetCursorPos(${Math.round(x)},${Math.round(y)}); [PerchMouse]::mouse_event(${down},0,0,0,0); [PerchMouse]::mouse_event(${up},0,0,0,0); Write-Output 'clicked'`);
    if (!result.ok) throw new Error(`Click failed: ${result.output}`);
    return `Clicked ${button} at ${Math.round(x)},${Math.round(y)}`;
  }

  async type(text: string): Promise<string> {
    const escaped = sendKeysEscape(text);
    const result = await this.run(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapeSingle(escaped)}'); Write-Output 'typed'`);
    if (!result.ok) throw new Error(`Type failed: ${result.output}`);
    return `Typed ${text.length} characters`;
  }

  async keys(keys: string): Promise<string> {
    const result = await this.run(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapeSingle(keys)}'); Write-Output 'sent'`);
    if (!result.ok) throw new Error(`Keys failed: ${result.output}`);
    return `Sent ${keys}`;
  }
}

function escapeSingle(value: string): string {
  return value.replace(/'/g, "''");
}

function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (match) => `{${match}}`);
}
