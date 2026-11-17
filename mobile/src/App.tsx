import React, { useEffect, useMemo, useRef, useState } from "react";
import { RelayTransport, relayConfigFromHash, type RelayConfig } from "./relay";

type ThreadStatus = "idle" | "queued" | "starting" | "running" | "waiting" | "completed" | "error" | "cancelled" | "parked";

interface Thread {
  id: string;
  nodeId: string;
  parentThreadId?: string | null;
  kind: "orchestrator" | "worker";
  title: string;
  status: ThreadStatus;
  statusMessage?: string;
  lastMessage?: string;
  updatedAt: number;
  archived?: boolean;
  interrupted?: boolean;
  unread?: number;
  model?: { name?: string; selector?: string };
  contextTokens?: number;
  contextWindow?: number;
  pendingApproval?: string;
}

interface Snapshot {
  nodes: Array<{ id: string; name: string; type: string; parentId: string | null; orchestratorThreadId: string }>;
  threads: Thread[];
  inbox: Envelope[];
  settings: { models?: Record<string, string> };
}

interface Envelope {
  id: string;
  subject: string;
  body: string;
  toThreadId?: string;
  fromNodeId?: string;
  requiresResponse?: boolean;
  status: string;
  createdAt: number;
}

interface MessageBlock {
  type: string;
  text?: string;
  name?: string;
  result?: string;
  status?: string;
}

interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  blocks: MessageBlock[];
  timestamp: number;
}

interface Approval {
  id: string;
  threadId: string;
  kind: string;
  title: string;
  message: string;
  options?: Array<{ label: string; value: string; description?: string }>;
}

const LS_SERVER = "omp.remote.server";
const LS_TOKEN = "omp.remote.token";

function cleanBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function App() {
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(() => relayConfigFromHash());
  const relayRef = useRef<RelayTransport | null>(null);
  const applyEventRef = useRef<(event: any) => void>(() => undefined);
  const [server, setServer] = useState(() => localStorage.getItem(LS_SERVER) || location.origin);
  const [token, setToken] = useState(() => {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const fromHash = hash.get("t") || hash.get("token");
    if (fromHash) {
      localStorage.setItem(LS_TOKEN, fromHash);
      history.replaceState(null, "", location.pathname + location.search);
      return fromHash;
    }
    return localStorage.getItem(LS_TOKEN) || "";
  });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<"sessions" | "inbox" | "settings">("sessions");
  const [filter, setFilter] = useState<"live" | "all">("live");
  const [query, setQuery] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const activeRef = useRef<string | null>(null);
  const openedFromLink = useRef(false);
  const [polling, setPolling] = useState(false);

  const base = cleanBase(server || location.origin);
  const active = snapshot?.threads.find((thread) => thread.id === activeId) ?? null;

  const ensureRelay = (): RelayTransport | null => {
    if (!relayConfig) return null;
    if (!relayRef.current) {
      relayRef.current = new RelayTransport(
        relayConfig,
        (event) => applyEventRef.current(event),
        (online) => {
          setConnected(online);
          if (!online) startPolling();
          else stopPolling();
        },
      );
    }
    return relayRef.current;
  };

  const api = async (path: string, init?: RequestInit) => {
    if (relayConfig) {
      const transport = ensureRelay()!;
      const response = await transport.request(path, init);
      if (response.status === 401) throw new Error("Relay pairing was rejected.");
      let body: any = {};
      try {
        body = response.body ? JSON.parse(response.body) : {};
      } catch {
        body = {};
      }
      if (response.status >= 400) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    }
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (response.status === 401) throw new Error("Pairing token was rejected.");
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    return response.json();
  };

  const connect = async () => {
    if (!token.trim() && !relayConfig) return;
    if (!relayConfig) {
      localStorage.setItem(LS_SERVER, base);
      localStorage.setItem(LS_TOKEN, token.trim());
    }
    setError("");
    try {
      if (relayConfig) await ensureRelay()!.connect();
      const state = await api("/api/state");
      setSnapshot(state);
      setConnected(true);
      void api("/api/approvals").then(setApprovals).catch(() => undefined);
      connectSocket();
    } catch (failure) {
      setConnected(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const connectSocket = () => {
    if (relayConfig) {
      ensureRelay()!
        .connect()
        .then(() => setConnected(true))
        .catch(() => setConnected(false));
      return;
    }
    wsRef.current?.close();
    if (retryRef.current) window.clearTimeout(retryRef.current);
    try {
      const url = new URL(base.replace(/^http/, "ws") + "/api/events");
      url.searchParams.set("token", token);
      const socket = new WebSocket(url);
      wsRef.current = socket;
      socket.onopen = () => { setConnected(true); setPolling(false); stopPolling(); };
      socket.onclose = () => {
        setConnected(false);
        startPolling();
        retryRef.current = window.setTimeout(() => {
          if (localStorage.getItem(LS_TOKEN)) connectSocket();
        }, 3000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (event) => applyEvent(JSON.parse(event.data));
    } catch {
      setConnected(false);
      startPolling();
    }
  };

  const refresh = async () => {
    try {
      const state = await api("/api/state");
      setSnapshot(state);
      setConnected(true);
      if (activeRef.current) {
        const data = await api(`/api/threads/${encodeURIComponent(activeRef.current)}`);
        setMessages((current) => ({ ...current, [activeRef.current!]: data.messages ?? [] }));
      }
      void api("/api/approvals").then(setApprovals).catch(() => undefined);
    } catch {
      setConnected(false);
    }
  };

  const startPolling = () => {
    setPolling(true);
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => void refresh(), 4000);
  };

  const stopPolling = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    setPolling(false);
  };

  const applyEvent = (event: any) => {
    if (!event?.type) return;
    setSnapshot((current) => {
      if (!current) return current;
      if (event.type === "snapshot") return event.payload;
      if (event.type === "thread:updated") {
        const exists = current.threads.some((thread) => thread.id === event.payload.id);
        return { ...current, threads: exists ? current.threads.map((thread) => (thread.id === event.payload.id ? event.payload : thread)) : [...current.threads, event.payload] };
      }
      if (event.type === "thread:status") {
        return {
          ...current,
          threads: current.threads.map((thread) => (thread.id === event.payload.threadId ? { ...thread, status: event.payload.status, statusMessage: event.payload.message ?? thread.statusMessage } : thread)),
        };
      }
      if (event.type === "thread:removed") return { ...current, threads: current.threads.filter((thread) => thread.id !== event.payload.id) };
      if (event.type === "node:updated") {
        const exists = current.nodes.some((node) => node.id === event.payload.id);
        return { ...current, nodes: exists ? current.nodes.map((node) => (node.id === event.payload.id ? event.payload : node)) : [...current.nodes, event.payload] };
      }
      if (event.type === "envelope:new" || event.type === "envelope:updated") {
        const envelope = event.payload as Envelope;
        const inbox = envelope.requiresResponse && !["answered", "cancelled", "expired"].includes(envelope.status)
          ? [...current.inbox.filter((item) => item.id !== envelope.id), envelope]
          : current.inbox.filter((item) => item.id !== envelope.id);
        return { ...current, inbox };
      }
      return current;
    });
    if (event.type === "thread:message") {
      const message = event.payload as Message;
      setMessages((current) => {
        const list = current[message.threadId] ?? [];
        if (!list.some((item) => item.id === message.id) && message.threadId !== activeId) return current;
        const next = list.some((item) => item.id === message.id) ? list.map((item) => (item.id === message.id ? message : item)) : [...list, message];
        next.sort((a, b) => a.timestamp - b.timestamp);
        return { ...current, [message.threadId]: next };
      });
    }
    if (event.type === "approval:request") setApprovals((current) => [...current.filter((item) => item.id !== event.payload.id), event.payload]);
    if (event.type === "approval:resolved") setApprovals((current) => current.filter((item) => item.id !== event.payload.id));
  };
  applyEventRef.current = applyEvent;

  useEffect(() => {
    if (!token && !relayConfig) return;
    void connect();
    return () => {
      wsRef.current?.close();
      relayRef.current?.close();
      if (retryRef.current) window.clearTimeout(retryRef.current);
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    activeRef.current = activeId;
    if (activeId) void refresh();
  }, [activeId]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if (!relayConfig && (!wsRef.current || wsRef.current.readyState > WebSocket.OPEN)) connectSocket();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const openThread = async (id: string) => {
    setActiveId(id);
    setTab("sessions");
    try {
      const data = await api(`/api/threads/${encodeURIComponent(id)}`);
      setMessages((current) => ({ ...current, [id]: data.messages ?? [] }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  useEffect(() => {
    if (!snapshot || openedFromLink.current) return;
    openedFromLink.current = true;
    const target = new URLSearchParams(location.search).get("thread");
    if (!target) return;
    history.replaceState(null, "", location.pathname);
    void openThread(target);
  }, [snapshot]);

  const send = async (text: string) => {
    if (!activeId || !text.trim()) return false;
    try {
      await api(`/api/threads/${encodeURIComponent(activeId)}/send`, { method: "POST", body: JSON.stringify({ text }) });
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  };

  const action = async (id: string, name: "stop" | "continue") => {
    try {
      await api(`/api/threads/${encodeURIComponent(id)}/${name}`, { method: "POST", body: "{}" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const answerApproval = async (approval: Approval, response: unknown) => {
    try {
      await api(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: "POST", body: JSON.stringify({ response }) });
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const threads = useMemo(() => {
    const list = [...(snapshot?.threads ?? [])];
    const live = new Set<ThreadStatus>(["running", "starting", "waiting", "queued"]);
    const matches = (thread: Thread) => {
      if (filter === "live" && !live.has(thread.status) && !thread.pendingApproval) return false;
      if (query.trim()) {
        const text = `${thread.title} ${thread.lastMessage ?? ""}`.toLowerCase();
        if (!text.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    };
    list.sort((a, b) => {
      const liveDelta = Number(live.has(b.status)) - Number(live.has(a.status));
      return liveDelta || b.updatedAt - a.updatedAt;
    });
    return list.filter(matches);
  }, [snapshot?.threads, filter, query]);

  const liveCount = (snapshot?.threads ?? []).filter((thread) => ["running", "starting", "waiting", "queued"].includes(thread.status) || thread.pendingApproval).length;

  if (!token && !relayConfig) {
    return <PairScreen server={server} setServer={setServer} token={token} setToken={setToken} onConnect={() => void connect()} error={error} />;
  }

  if (active) {
    return (
      <div className="app">
        <header className="chat-head">
          <button className="icon" onClick={() => setActiveId(null)} aria-label="Back">←</button>
          <div className="chat-title">
            <strong>{active.title}</strong>
            <span><i className={`dot ${active.status}`} /> {statusLabel(active.status)}{active.statusMessage ? ` · ${active.statusMessage}` : ""}</span>
          </div>
          <button className="icon" onClick={() => void openThread(active.id)} aria-label="Refresh">⟳</button>
        </header>
        <main className="messages">
          {(messages[active.id] ?? []).map((message) => (
            <article key={message.id} className={`msg ${message.role}`}>
              {message.blocks.map((block, index) => block.type === "text" ? (
                <p key={index}>{block.text}</p>
              ) : block.type === "tool" ? (
                <div key={index} className="tool">{block.name}<span>{block.status ?? ""}</span>{block.result ? <pre>{block.result.slice(0, 1200)}</pre> : null}</div>
              ) : null)}
            </article>
          ))}
          {!(messages[active.id] ?? []).length ? <p className="empty">No messages yet.</p> : null}
        </main>
        {approvals.filter((item) => item.threadId === active.id || !item.threadId).slice(0, 1).map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onAnswer={answerApproval} />
        ))}
        <Composer
          disabled={false}
          running={["running", "starting"].includes(active.status)}
          onSend={send}
          onStop={() => void action(active.id, "stop")}
          onContinue={() => void action(active.id, "continue")}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div><strong>OMP Remote</strong><span>{connected ? "connected" : "offline"}{liveCount ? ` · ${liveCount} live` : ""}</span></div>
        <button className="icon" onClick={() => void connect()} aria-label="Refresh">⟳</button>
      </header>
      {error ? <div className="banner">{error}</div> : null}
      {tab === "sessions" ? (
        <>
          <div className="filters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
            <div className="segmented">
              <button className={filter === "live" ? "active" : ""} onClick={() => setFilter("live")}>Live</button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
            </div>
          </div>
          <main className="list">
            {threads.map((thread) => (
              <button key={thread.id} className="session" onClick={() => void openThread(thread.id)}>
                <div className="session-top">
                  <i className={`dot ${thread.status}`} />
                  <strong>{thread.title}</strong>
                  <span>{relativeTime(thread.updatedAt)}</span>
                </div>
                <p>{thread.lastMessage || thread.statusMessage || statusLabel(thread.status)}</p>
                <div className="meta">
                  <span>{thread.kind}</span>
                  <span>{nodeName(snapshot, thread.nodeId)}</span>
                  {thread.pendingApproval ? <span className="warn">approval needed</span> : null}
                  {thread.interrupted ? <span className="warn">interrupted</span> : null}
                </div>
              </button>
            ))}
            {!threads.length ? <p className="empty">No sessions. Send a task from the desktop app.</p> : null}
          </main>
        </>
      ) : null}
      {tab === "inbox" ? (
        <main className="list">
          {(snapshot?.inbox ?? []).map((envelope) => <InboxCard key={envelope.id} envelope={envelope} onAnswer={async (body) => {
            await api(`/api/envelopes/${encodeURIComponent(envelope.id)}/answer`, { method: "POST", body: JSON.stringify({ body }) });
          }} />)}
          {!(snapshot?.inbox ?? []).length ? <p className="empty">No messages need a reply.</p> : null}
        </main>
      ) : null}
      {tab === "settings" ? (
        <SettingsSheet
          server={server}
          setServer={setServer}
          token={token}
          setToken={setToken}
          relay={relayConfig}
          apiFetch={api}
          onReconnect={() => void connect()}
          onForget={() => {
            localStorage.removeItem(LS_TOKEN);
            localStorage.removeItem(LS_SERVER);
            localStorage.removeItem("omp.relay");
            relayRef.current?.close();
            setRelayConfig(null);
            setToken("");
            setSnapshot(null);
            setConnected(false);
          }}
        />
      ) : null}
      <nav className="tabs">
        <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>
        <button className={tab === "inbox" ? "active" : ""} onClick={() => setTab("inbox")}>Inbox{snapshot?.inbox?.length ? ` ${snapshot.inbox.length}` : ""}</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
      </nav>
    </div>
  );
}

function PairScreen({ server, setServer, token, setToken, onConnect, error }: { server: string; setServer: (value: string) => void; token: string; setToken: (value: string) => void; onConnect: () => void; error: string }) {
  return (
    <div className="pair">
      <div className="brand">OMP <span>Remote</span></div>
      <p>Enter the runner URL and the pairing token shown in OMP Studio → Settings → Remote.</p>
      <label>Runner URL<input value={server} onChange={(event) => setServer(event.target.value)} placeholder="http://100.x.x.x:43120" autoCapitalize="none" /></label>
      <label>Pairing token<input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste token" autoCapitalize="none" /></label>
      {error ? <div className="banner">{error}</div> : null}
      <button className="primary" onClick={onConnect} disabled={!token.trim()}>Connect</button>
      <small>On your phone use Tailscale, then open the runner URL. Nothing is exposed publicly.</small>
    </div>
  );
}

function SettingsSheet({ server, setServer, token, setToken, relay, apiFetch, onReconnect, onForget }: {
  server: string;
  setServer: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  relay?: RelayConfig | null;
  apiFetch: (path: string, init?: RequestInit) => Promise<any>;
  onReconnect: () => void;
  onForget: () => void;
}) {
  const [push, setPush] = useState<"unknown" | "enabled" | "disabled" | "unsupported" | "error">("unknown");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) setPush("unsupported");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setPush(subscription ? "enabled" : "disabled");
      } catch {
        if (!cancelled) setPush("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const enablePush = async () => {
    setPushBusy(true);
    setPushMessage("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push is not available in this browser. On iPhone, install the PWA to the Home Screen first.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await apiFetch("/api/push/key");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await apiFetch("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      setPush("enabled");
      setPushMessage("Notifications are on.");
    } catch (error) {
      setPush("error");
      setPushMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    setPushBusy(true);
    setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await apiFetch("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setPush("disabled");
      setPushMessage("Notifications are off.");
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  };

  const testPush = async () => {
    setPushBusy(true);
    setPushMessage("");
    try {
      const result = await apiFetch("/api/push/test", { method: "POST", body: "{}" });
      setPushMessage(result.sent ? `Test sent to ${result.sent} device(s).` : `No subscription accepted the test (${result.failed ?? 0} failed).`);
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <main className="settings">
      {relay ? (
        <section className="settings-block">
          <strong>Connected through relay</strong>
          <p className="hint">{relay.relay} · room {relay.room}<br />Traffic is end-to-end encrypted; the relay only forwards ciphertext.</p>
        </section>
      ) : (
        <>
          <label>Runner URL<input value={server} onChange={(event) => setServer(event.target.value)} autoCapitalize="none" /></label>
          <label>Pairing token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
        </>
      )}
      <button className="primary" onClick={onReconnect}>Reconnect</button>
      <section className="settings-block">
        <strong>Notifications</strong>
        <p className="hint">
          Get a push when a session needs input or approval. On iPhone, add the PWA to the Home Screen first.
          {push === "unsupported" ? " Push is not exposed by this browser." : ""}
        </p>
        <div className="settings-row">
          {push === "enabled"
            ? <button className="ghost" disabled={pushBusy} onClick={() => void disablePush()}>Turn off</button>
            : <button className="primary" disabled={pushBusy || push === "unsupported"} onClick={() => void enablePush()}>Enable notifications</button>}
          <button className="ghost" disabled={pushBusy} onClick={() => void testPush()}>Send test</button>
        </div>
        {pushMessage ? <p className="hint">{pushMessage}</p> : null}
      </section>
      <button className="danger" onClick={() => { if (confirm("Forget this runner on this device?")) onForget(); }}>Forget this runner</button>
      <p className="hint">The token is stored on this device. Rotate it in OMP Studio to revoke all devices.</p>
    </main>
  );
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function Composer({ running, disabled, onSend, onStop, onContinue }: { running: boolean; disabled: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void; onContinue: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="composer">
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={running ? "Steer this turn…" : "Ask the agent…"} rows={2} />
      <div className="composer-actions">
        {running ? <button className="danger" onClick={onStop}>Stop</button> : <button className="ghost" onClick={onContinue}>Continue</button>}
        <button className="primary" disabled={disabled || busy || !text.trim()} onClick={async () => {
          setBusy(true);
          const ok = await onSend(text);
          if (ok) setText("");
          setBusy(false);
        }}>Send</button>
      </div>
    </div>
  );
}

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (approval: Approval, response: unknown) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="approval">
      <strong>{approval.title}</strong>
      <p>{approval.message}</p>
      {approval.kind === "confirm" ? (
        <div className="row"><button className="danger" onClick={() => onAnswer(approval, false)}>Deny</button><button className="primary" onClick={() => onAnswer(approval, true)}>Approve</button></div>
      ) : approval.kind === "select" ? (
        <div className="options">{(approval.options ?? []).map((option) => <button key={option.value} onClick={() => onAnswer(approval, option.value)}>{option.label}</button>)}</div>
      ) : (
        <div className="row"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Reply" /><button className="primary" disabled={!text.trim()} onClick={() => onAnswer(approval, text)}>Send</button></div>
      )}
    </div>
  );
}

function InboxCard({ envelope, onAnswer }: { envelope: Envelope; onAnswer: (body: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return (
    <div className="session inbox-card">
      <strong>{envelope.subject}</strong>
      <p>{envelope.body}</p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} placeholder="Your answer" />
      <button className="primary" disabled={!text.trim()} onClick={async () => { await onAnswer(text); setText(""); }}>Answer</button>
    </div>
  );
}

function nodeName(snapshot: Snapshot | null, nodeId: string): string {
  return snapshot?.nodes.find((node) => node.id === nodeId)?.name ?? "";
}

function statusLabel(status: ThreadStatus): string {
  return status === "waiting" ? "needs input" : status;
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}







