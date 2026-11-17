import { BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import type { ChatMessage } from "../../shared/types";
import type { ArtifactService } from "./artifacts";
import type { Store } from "./store";

export class ExportService {
  private store: Store;
  private artifacts: ArtifactService;

  constructor(store: Store, artifacts: ArtifactService) {
    this.store = store;
    this.artifacts = artifacts;
  }

  async threadDocx(threadId: string): Promise<{ path: string }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const messages = this.store.getChat(threadId);
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    const paragraphs: string[] = [];
    paragraphs.push(paragraph(thread.title, true));
    paragraphs.push(paragraph(`${thread.model.name ?? thread.model.selector} · exported ${new Date().toLocaleString()}`));
    for (const message of messages) {
      paragraphs.push(paragraph(message.role.toUpperCase(), true));
      for (const block of message.blocks) {
        if (block.type === "text" || block.type === "thinking") {
          for (const line of block.text.split(/\r?\n/)) paragraphs.push(paragraph(block.type === "thinking" ? `[thinking] ${line}` : line));
        } else if (block.type === "tool") {
          paragraphs.push(paragraph(`[tool ${block.name}]`));
          if (block.result) for (const line of block.result.slice(0, 6_000).split(/\r?\n/)) paragraphs.push(paragraph(line));
        }
      }
    }
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const directory = join(this.store.baseDir, "artifacts", "exports");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${slug(thread.title)}-${Date.now()}.docx`);
    writeFileSync(path, buffer);
    this.artifacts.recordFile(thread, path, this.store.baseDir);
    return { path };
  }

  async threadPdf(threadId: string): Promise<{ path: string }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const messages = this.store.getChat(threadId);
    const html = renderThread(thread.title, thread.model.name ?? thread.model.selector, messages);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } });
      const directory = join(this.store.baseDir, "artifacts", "exports");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${slug(thread.title)}-${Date.now()}.pdf`);
      writeFileSync(path, pdf);
      this.artifacts.recordFile(thread, path, this.store.baseDir);
      return { path };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

function renderThread(title: string, model: string, messages: ChatMessage[]): string {
  const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = messages
    .map((message) => {
      const blocks = message.blocks
        .map((block) => {
          if (block.type === "text" || block.type === "thinking") return `<div class="text ${block.type}">${escaped(block.text).replace(/\n/g, "<br/>")}</div>`;
          if (block.type === "tool") return `<div class="tool"><span>${escaped(block.name)}</span>${block.result ? `<pre>${escaped(block.result.slice(0, 6_000))}</pre>` : ""}</div>`;
          if (block.type === "image" && block.data && block.data.length < 2_000_000) return `<img src="data:${block.mimeType || "image/png"};base64,${block.data}" />`;
          return "";
        })
        .join("");
      return `<article class="msg ${message.role}"><header><strong>${message.role}</strong><span>${new Date(message.timestamp).toLocaleString()}</span>${message.usage?.totalTokens ? `<span>${message.usage.totalTokens} tokens</span>` : ""}</header>${blocks}</article>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    body{font:12px/1.55 -apple-system,Segoe UI,sans-serif;color:#1f1d2b;margin:0;padding:28px;background:#fff}
    h1{font-size:20px;margin:0 0 2px} .meta{color:#6b6780;margin-bottom:22px}
    .msg{border:1px solid #e4e2ec;border-radius:8px;padding:10px 12px;margin:0 0 10px;page-break-inside:avoid}
    .msg header{display:flex;gap:10px;color:#6b6780;font-size:10px;margin-bottom:5px;text-transform:uppercase}
    .msg.user{background:#f7f4ff;border-color:#d9d1ff}.text{margin:3px 0}
    .tool{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#4b4760;margin:4px 0}
    .tool span{font-weight:600}.tool pre{white-space:pre-wrap;margin:3px 0;max-height:220px;overflow:hidden}
    img{max-width:100%;border-radius:6px;margin:4px 0}
    .thinking{color:#7a7590;font-style:italic}
  </style></head><body><h1>${escaped(title)}</h1><div class="meta">${escaped(model)} · exported ${new Date().toLocaleString()}</div>${body}</body></html>`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "thread";
}

function paragraph(text: string, bold = false): string {
  const properties = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  const run = "<w:r>" + properties + '<w:t xml:space="preserve">' + escapeXml(text) + "</w:t></w:r>";
  return "<w:p>" + run + "</w:p>";
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
