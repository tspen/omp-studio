import React, { useEffect } from "react";
import { Bell, Globe, Inbox, Search, Settings } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { BrowserPanel } from "./components/BrowserPanel";
import { PaneHost, PopoutPane } from "./components/PaneHost";
import { ThreadRail } from "./components/ThreadRail";
import { SettingsModal } from "./components/SettingsModal";
import { ApprovalModal, Modals } from "./components/Modals";
import { Onboarding } from "./components/Onboarding";
import { Badge, IconButton, Logo, Toasts, cx } from "./components/Common";
import { selectedNode, selectedThread, useApp } from "./store";
import type { PaneKind } from "../../shared/types";
import { unlockSounds } from "./sounds";

export function App() {
  const state = useApp();

  useEffect(() => {
    void state.init();
  }, []);

  useEffect(() => {
    const unlock = () => unlockSounds();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const theme = state.snapshot?.settings.theme ?? "light";
    const apply = () => {
      const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      void window.perch.setWindowTheme(resolved);
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
        <h1>Perch</h1>
        <p>Bringing up the tree and the Pi engine…</p>
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
  const running = state.snapshot.threads.filter((item) => item.status === "running").length;
  const waiting = state.snapshot.threads.filter((item) => item.status === "waiting" || item.pendingApproval).length;
  const paneParam = new URLSearchParams(window.location.search).get("pane") as PaneKind | null;
  const paneThread = new URLSearchParams(window.location.search).get("thread") ?? undefined;
  if (paneParam === "terminal" || paneParam === "diff" || paneParam === "tasks") {
    return <PopoutPane kind={paneParam} threadId={paneThread || undefined} />;
  }

  return (
    <div className="app">
      <TitleBar unread={unread} running={running} waiting={waiting} />
      <div className="shell" style={{ "--sidebar-width": `${state.paneWidths.sidebar}px`, "--right-width": `${state.paneWidths.right}px`, "--browser-width": `${state.paneWidths.browser}px` } as React.CSSProperties}>
        <Sidebar />
        <Splitter pane="sidebar" />
        <div className="main-column">
          <ChatView />
          {state.paneOpen ? <PaneHost /> : null}
        </div>
        {state.browserOpen ? <><Splitter pane="browser" /><BrowserPanel /></> : null}
        {state.railOpen ? <><Splitter pane="right" /><ThreadRail /></> : null}
      </div>
      <div className="statusbar">
        <div className="statusbar-left">
          <span className="statusbar-item"><span className={cx("engine-dot", state.engine?.found ? "ok" : "bad")} /> {state.engine?.found ? `Pi ${state.engine.version}` : "Pi not found"}</span>
          <span className="statusbar-item">{running ? `${running} running` : "All quiet"}{waiting ? ` / ${waiting} waiting` : ""}</span>
        </div>
        <div className="statusbar-right">
          <span>{node ? node.name : "No node"}</span>
          <span>{thread ? thread.model.name ?? thread.model.selector : "No thread"}</span>
        </div>
      </div>

      {state.overlay === "settings" ? <SettingsModal /> : null}
      {state.overlay !== "settings" ? <Modals /> : null}
      <ApprovalModal />
      <Toasts toasts={state.toasts} dismiss={state.dismissToast} />
    </div>
  );
}

function Splitter({ pane }: { pane: "sidebar" | "right" | "browser" }) {
  const onDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const state = useApp.getState();
    const startX = event.clientX;
    const start = state.paneWidths[pane];
    document.body.classList.add("resizing");
    const onMove = (moveEvent: MouseEvent) => {
      const delta = pane === "right" || pane === "browser" ? startX - moveEvent.clientX : moveEvent.clientX - startX;
      useApp.getState().setPaneWidth(pane, start + delta);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      const widths = useApp.getState().paneWidths;
      const settings = useApp.getState().snapshot?.settings;
      if (settings) void window.perch.updateSettings({ settings: { ui: { ...settings.ui, sidebarWidth: widths.sidebar, rightWidth: widths.right } } });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return <div className={cx("pane-splitter", `pane-${pane}`)} onMouseDown={onDown} />;
}

function TitleBar({ unread, running, waiting }: { unread: number; running: number; waiting: number }) {
  const state = useApp();
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="titlebar-logo"><Logo size={20} /></div>
        <span className="titlebar-name">Perch</span>
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
        <button type="button" className="titlebar-icon" title="Browser" onClick={() => state.openBrowser()}><Globe size={15} /></button>
        <button type="button" className="titlebar-icon" title="Settings" onClick={() => state.setSettingsTab("general")}><Settings size={15} /></button>
        <div className="titlebar-drag-space" />
      </div>
    </header>
  );
}
