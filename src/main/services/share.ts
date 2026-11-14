import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ShareInfo, Thread } from "../../shared/types";
import type { Store } from "./store";

export class ShareService {
  private store: Store;
  private server: Server | null = null;
  private info: ShareInfo | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  current(): ShareInfo | undefined {
    return this.info ?? undefined;
  }

  async start(threadId: string): Promise<ShareInfo> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    if (this.info && this.info.threadId === threadId && this.info.active) return this.info;
    await this.stop();
    const token = randomUUID().replace(/-/g, "");
    const port = await this.listen(this.store.settings.share.port || 4337);
    this.server = createServer((req, res) => this.handle(req, res, threadId, token));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.info = {
      threadId,
      token,
      url: `http://127.0.0.1:${port}/s/${token}`,
      createdAt: Date.now(),
      active: true,
    };
    return this.info;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.info = null;
  }

  private async listen(preferred: number): Promise<number> {
    for (let port = preferred; port < preferred + 30; port++) {
      const available = await isPortFree(port);
      if (available) return port;
    }
    throw new Error("No free port for sharing");
  }

  private handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, threadId: string, token: string): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(`/s/${token}`)) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (url.pathname.endsWith("/state")) {
      const thread = this.store.getThread(threadId);
      const messages = this.store.getChat(threadId);
      const envelopes = this.store.listEnvelopes({ threadId, limit: 200 });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ thread, messages, envelopes }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderPage(token, this.store.getThread(threadId)));
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function renderPage(token: string, thread: Thread | undefined): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(thread?.title ?? "OMP Studio share")}</title>
<style>
:root{color-scheme:light;--bg:#f7f7f8;--card:#fff;--text:#1d1d21;--muted:#6b6b76;--line:#e6e6ea;--accent:#6556d9}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
header{position:sticky;top:0;background:#fffffff2;backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:12px;align-items:center}
header h1{font-size:15px;margin:0;font-weight:650}.badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#ece9ff;color:#4b3bd6}
main{max-width:860px;margin:0 auto;padding:20px}.msg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:10px 0;white-space:pre-wrap;word-break:break-word}
.msg.user{background:#f0eeff;border-color:#ddd8ff}.meta{font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
.tool{font-family:ui-monospace,monospace;font-size:12px;background:#f5f5f7;border-radius:8px;padding:6px 8px;margin:6px 0;color:#444}
.env{border-left:3px solid var(--accent);background:#fbfaff;border-radius:6px;padding:6px 10px;margin:8px 0;font-size:12px;color:#555}
.empty{color:var(--muted);text-align:center;padding:40px}
</style></head><body>
<header><h1>${escapeHtml(thread?.title ?? "Thread")}</h1><span class="badge">live read-only</span><span style="color:var(--muted);font-size:12px" id="status"></span></header>
<main id="root"><div class="empty">Loading…</div></main>
<script>
const token=${JSON.stringify(token)};
async function tick(){
  try{
    const r=await fetch('/s/'+token+'/state',{cache:'no-store'});
    const data=await r.json();
    document.getElementById('status').textContent=data.thread? data.thread.status : '';
    const root=document.getElementById('root');
    if(!data.messages.length){root.innerHTML='<div class="empty">No messages yet.</div>';return;}
    root.innerHTML=data.messages.map(m=>{
      const blocks=(m.blocks||[]).map(b=>{
        if(b.type==='text') return '<div>'+esc(b.text)+'</div>';
        if(b.type==='thinking') return '<div class="tool">thinking · '+esc((b.text||'').slice(0,1200))+'</div>';
        if(b.type==='tool') return '<div class="tool">'+esc(b.name)+' · '+esc(b.status)+(b.result?' · '+esc(String(b.result).slice(0,800)):'')+'</div>';
        return '';
      }).join('');
      return '<article class="msg '+(m.role==='user'?'user':'')+'"><div class="meta">'+esc(m.role)+' · '+new Date(m.timestamp).toLocaleTimeString()+'</div>'+blocks+'</article>';
    }).join('');
  }catch(e){document.getElementById('root').innerHTML='<div class="empty">Connection lost.</div>';}
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
tick();setInterval(tick,2500);
</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
