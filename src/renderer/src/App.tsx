import React, { useEffect } from "react";
import { Bell, Command, Inbox, Search, Settings, Sparkles } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ThreadRail } from "./components/ThreadRail";
import { SettingsModal } from "./components/SettingsModal";
import { ApprovalModal, Modals } from "./components/Modals";
import { Onboarding } from "./components/Onboarding";
import { Badge, IconButton, Logo, Toasts, cx, formatCost, formatNumber } from "./components/Common";
import { selectedNode, selectedThread, useApp } from "./store";

export function App() {
  const state = useApp();

  useEffect(() => {
    void state.init();
  }, []);

  useEffect(() => {
    const theme = state.snapshot?.settings.theme ?? "light";
    const apply = () => {
      const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      void window.omp.setWindowTheme(resolved);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.snapshot?.settings.theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        state.setOverlay("search");
      } else if (event.key === ",") {
        event.preventDefault();
        state.setSettingsTab("general");
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        state.setOverlay("new-thread");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state.snapshot) {
    return (
      <div className="boot">
        <Logo size={44} />
        <h1>OMP Studio</h1>
        <p>Bringing up the tree and the OMP engine…</p>
        <div className="boot-bar"><i /></div>
      </div>
    );
  }

  if (!state.snapshot.settings.onboardingCompleted) {
    return <Onboarding />;
  }

  const node = selectedNode(state);
  const thread = selectedThread(state);
  const unread = state.notifications.filter((item) => !item.read).length;
  const groups = state.snapshot.nodes.filter((item) => item.type === "group").length;
  const projects = state.snapshot.nodes.filter((item) => item.type === "project").length;
  const running = state.snapshot.threads.filter((item) => item.status === "running").length;
  const waiting = state.snapshot.threads.filter((item) => item.status === "waiting" || item.pendingApproval).length;

  return (
    <div className="app">
      <TitleBar unread={unread} running={running} waiting={waiting} />
      <div className="shell">
        <Sidebar />
        <ChatView />
        {state.railOpen ? <ThreadRail /> : null}
      </div>
      <div className="statusbar">
        <div className="statusbar-left">
          <span className="statusbar-item"><span className={cx("engine-dot", state.engine?.found ? "ok" : "bad")} /> {state.engine?.found ? `OMP ${state.engine.version}` : "OMP not found"}</span>
          <span className="statusbar-item">{groups} groups · {projects} projects · {running} running · {waiting} waiting</span>
          <span className="statusbar-item">{formatNumber(state.snapshot.usage.totalTokens)} tokens · {formatCost(state.snapshot.usage.totalCost)} metered{state.snapshot.usage.referenceCost ? ` · ${formatCost(state.snapshot.usage.referenceCost)} included ref` : ""}</span>
        </div>
        <div className="statusbar-right">
          <span>{node ? `${node.type}: ${node.name}` : "No node"}</span>
          <span>{thread ? thread.model.name ?? thread.model.selector : "No thread"}</span>
          <span>{thread ? `${thread.effort} effort` : ""}</span>
        </div>
      </div>

      {state.overlay === "settings" ? <SettingsModal /> : null}
      {state.overlay !== "settings" ? <Modals /> : null}
      <ApprovalModal />
      <Toasts toasts={state.toasts} dismiss={state.dismissToast} />
    </div>
  );
}

function TitleBar({ unread, running, waiting }: { unread: number; running: number; waiting: number }) {
  const state = useApp();
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="titlebar-logo"><Logo size={20} /></div>
        <span className="titlebar-name">OMP Studio</span>
        <span className="titlebar-sep" />
        <span className="titlebar-context">{state.snapshot?.nodes.find((node) => node.type === "root")?.name ?? "Mission Control"}</span>
      </div>
      <div className="titlebar-center">
        <button type="button" className="command-search" onClick={() => state.setOverlay("search")}>
          <Search size={13} />
          <span>Search threads, projects, messages</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div className="titlebar-right">
        {running ? <Badge tone="blue">{running} running</Badge> : null}
        {waiting ? <Badge tone="amber">{waiting} waiting</Badge> : null}
        <button type="button" className="titlebar-icon" title="Inbox" onClick={() => state.setOverlay("inbox")}>
          <Bell size={15} />
          {unread ? <span className="titlebar-badge">{unread > 9 ? "9+" : unread}</span> : null}
        </button>
        <button type="button" className="titlebar-icon" title="Settings" onClick={() => state.setSettingsTab("general")}><Settings size={15} /></button>
        <div className="titlebar-drag-space" />
      </div>
    </header>
  );
}
