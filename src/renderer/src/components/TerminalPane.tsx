import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ExternalLink, Plus, Square, Trash2 } from "lucide-react";
import { selectedNode, selectedThread, useApp } from "../store";import { Button, IconButton, cx, relativeTime, truncate } from "./Common";

export function XtermView({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: { background: "#14131c", foreground: "#e7e5f2", cursor: "#9c8cff", selectionBackground: "#3c3560" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const refit = () => {
      try {
        fit.fit();
        void window.omp.resizePty(sessionId, term.cols, term.rows);
      } catch {
        /* hidden */
      }
    };
    requestAnimationFrame(refit);
    const onData = term.onData((data) => {
      void window.omp.writePty(sessionId, data).catch(() => undefined);
    });
    void window.omp.readPty(sessionId).then((text: string) => {
      if (text) term.write(text.slice(-200_000));
      term.scrollToBottom();
    });
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; chunk: string }>).detail;
      if (detail?.sessionId === sessionId) term.write(detail.chunk);
    };
    window.addEventListener("omp:pty", onEvent);
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    term.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("omp:pty", onEvent);
      onData.dispose();
      term.dispose();
    };
  }, [sessionId]);

  return <div className="pty-host" ref={hostRef} />;
}

export function ShellsTab() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const nodeId = node?.id;
  const threadId = thread?.id;
  const sessions = state.ptySessions;
  const [activeId, setActiveId] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    void state.loadPtySessions();
  }, []);

  useEffect(() => {
    if (activeId && sessions.some((session) => session.id === activeId)) return;
    const last = [...sessions].reverse().find((session) => session.status === "running") ?? sessions[sessions.length - 1];
    setActiveId(last?.id ?? null);
  }, [sessions, activeId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!sessions.length && nodeId) {
      void state.startPty({ nodeId, threadId }).then((session) => {
        if (session) setActiveId(session.id);
      });
    }
  }, [nodeId, threadId, sessions.length]);

  const active = sessions.find((session) => session.id === activeId) ?? null;

  const create = async () => {
    const session = await state.startPty({ nodeId, threadId });
    if (session) setActiveId(session.id);
  };

  return (
    <div className="pty-layout">
      <div className="pty-sessions">
        <div className="pty-sessions-head">
          <span>Shells</span>
          <IconButton icon={<Plus size={13} />} label="New shell" onClick={() => void create()} />
        </div>
        {sessions.map((session) => (
          <button key={session.id} type="button" className={cx("pty-tab", session.id === activeId && "active")} onClick={() => setActiveId(session.id)}>
            <span className={cx("run-dot", session.status === "running" ? "running" : "done")} />
            <span className="pty-tab-title">{truncate(session.title, 26)}</span>
            <span className="pty-tab-time">{relativeTime(session.updatedAt)}</span>
          </button>
        ))}
        {!sessions.length ? <p className="rail-empty">No shells yet.</p> : null}
      </div>
      <div className="pty-main">
        <div className="pty-bar">
          <span className="pty-cwd mono" title={active?.cwd}>{active ? truncate(active.cwd, 52) : "No shell"}</span>
          {(active?.urls ?? []).map((url) => (
            <button key={url} type="button" className="pty-url" onClick={() => { state.openBrowser(url); state.setOverlay("none"); }}>
              <ExternalLink size={11} /> {url.replace("http://127.0.0.1", "")}
            </button>
          ))}
          {active?.status === "running" ? (
            <Button size="sm" variant="ghost" onClick={() => void state.killPty(active.id)}><Square size={11} /> Stop</Button>
          ) : null}
          {active ? (
            <IconButton icon={<Trash2 size={13} />} label="Kill shell" onClick={() => { void state.killPty(active.id); }} />
          ) : null}
        </div>
        {active ? (
          <XtermView key={active.id} sessionId={active.id} />
        ) : (
          <div className="pty-empty">
            <p>No shell open.</p>
            <Button size="sm" variant="primary" onClick={() => void create()}><Plus size={13} /> New shell</Button>
          </div>
        )}
      </div>
    </div>
  );
}
