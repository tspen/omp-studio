import React, { useEffect, useState } from "react";
import { FileDiff, ListChecks, Maximize2, Play, TerminalSquare, X } from "lucide-react";
import type { PaneDiff, PaneKind } from "../../../shared/types";
import { selectedThread, useApp } from "../store";
import { Empty, IconButton, cx, statusLabel, truncate } from "./Common";
import { ShellsTab } from "./TerminalPane";

const TABS: Array<{ kind: PaneKind; label: string; icon: React.ReactNode }> = [
  { kind: "terminal", label: "Terminal", icon: <TerminalSquare size={12} /> },
  { kind: "diff", label: "Diff", icon: <FileDiff size={12} /> },
  { kind: "tasks", label: "Tasks", icon: <ListChecks size={12} /> },
];

export function PaneHost() {
  const state = useApp();
  const popOut = () => {
    void window.omp.popOutPane({
      kind: state.paneTab,
      threadId: state.selectedThreadId ?? undefined,
      ...(state.paneTab === "diff" && state.paneDiff ? { diff: state.paneDiff } : {}),
    });
  };
  const resize = (event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = state.paneHeight;
    const onMove = (moveEvent: MouseEvent) => state.setPaneHeight(startHeight - (moveEvent.clientY - startY));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-row");
    };
    document.body.classList.add("resizing-row");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <section className="pane-host" style={{ height: state.paneHeight }}>
      <div className="pane-resize" onMouseDown={resize} />
      <header className="pane-host-head">
        <div className="pane-host-tabs">
          {TABS.map((tab) => (
            <button key={tab.kind} type="button" className={cx("pane-host-tab", state.paneTab === tab.kind && "active")} onClick={() => state.setPaneTab(tab.kind)}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
        <span className="pane-host-spacer" />
        <button type="button" className="pane-host-link" onClick={() => state.setOverlay("terminal")} title="Open one-off command runs">
          <Play size={11} /> Runs
        </button>
        <IconButton icon={<Maximize2 size={13} />} label="Pop out pane" onClick={popOut} />
        <IconButton icon={<X size={13} />} label="Close pane" onClick={state.closePane} />
      </header>
      <div className="pane-host-body">
        <PaneContent kind={state.paneTab} diff={state.paneDiff} />
      </div>
    </section>
  );
}

export function PaneContent({ kind, diff, standalone = false }: { kind: PaneKind; diff?: PaneDiff | null; standalone?: boolean }) {
  if (kind === "terminal") return <ShellsTab />;
  if (kind === "diff") return <DiffPane diff={diff ?? null} standalone={standalone} />;
  return <TasksPane />;
}

function DiffPane({ diff, standalone }: { diff: PaneDiff | null; standalone: boolean }) {
  const state = useApp();
  if (!diff) {
    return <Empty icon={<FileDiff size={20} />} title="No diff open" body="Open a changed file from the Git tab to review it here." />;
  }
  const lines = diff.content.split("\n");
  return (
    <div className="pane-diff">
      <div className="pane-diff-head">
        <strong>{truncate(diff.title, 90)}</strong>
        {diff.path ? <span className="mono">{diff.path}</span> : null}
        <span className="pane-host-spacer" />
        {diff.review && !standalone ? (
          <button type="button" className="pane-host-link" onClick={() => state.openPreview({ title: diff.title, kind: "diff", content: diff.content, path: diff.path, review: diff.review })}>
            Full review & comments
          </button>
        ) : null}
      </div>
      <pre className="pane-diff-body">
        {lines.map((line, index) => {
          const className = line.startsWith("+++") || line.startsWith("---") ? "diff-same" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : "diff-same";
          return (
            <div key={index} className={className}>
              <span className="diff-marker">{line.startsWith("@@") ? "" : line[0] === "+" || line[0] === "-" ? line[0] : " "}</span>
              {line.replace(/^[+-]/, "")}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TasksPane() {
  const state = useApp();
  const thread = selectedThread(state);
  const phases = thread?.todoPhases ?? [];
  if (!thread) return <Empty icon={<ListChecks size={20} />} title="No thread selected" body="Select a thread to see its task phases." />;
  if (!phases.length) {
    return <Empty icon={<ListChecks size={20} />} title="No tasks yet" body="OMP todo phases for this thread appear here as the agent plans work." />;
  }
  return (
    <div className="pane-tasks">
      <div className="pane-tasks-head">
        <strong>{thread.title}</strong>
        <span className={cx("pane-task-status", thread.status)}>{statusLabel(thread.status)}</span>
      </div>
      {phases.map((phase, phaseIndex) => (
        <div key={`${phase.name}-${phaseIndex}`} className="pane-task-phase">
          <div className="pane-task-phase-head">
            <span>{phase.name}</span>
            <span>{phase.tasks.filter((task) => task.status === "completed").length}/{phase.tasks.length}</span>
          </div>
          {phase.tasks.map((task, index) => (
            <div key={`${task.content}-${index}`} className={cx("pane-task", task.status)}>
              <span className="pane-task-dot" />
              <span>{task.content}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PopoutPane({ kind, threadId }: { kind: PaneKind; threadId?: string }) {
  const state = useApp();
  const [diff, setDiff] = useState<PaneDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(kind === "diff");

  useEffect(() => {
    if (kind !== "diff") return;
    void window.omp.getPaneData("diff").then((data: PaneDiff | null) => setDiff(data)).finally(() => setLoadingDiff(false));
  }, [kind]);

  useEffect(() => {
    if (!threadId || !state.initialized) return;
    if (state.selectedThreadId !== threadId) void state.selectThread(threadId);
  }, [threadId, state.initialized, state.selectedThreadId]);

  return (
    <div className="popout-root">
      <header className="popout-head">
        <span>{TABS.find((tab) => tab.kind === kind)?.label ?? "Pane"}</span>
        <span>{state.selectedThreadId ? truncate(state.snapshot?.threads.find((thread) => thread.id === state.selectedThreadId)?.title ?? "", 60) : ""}</span>
        <button type="button" className="pane-host-link" onClick={() => void window.omp.closeWindow()}><X size={12} /> Close</button>
      </header>
      <div className="popout-body">
        {loadingDiff ? <div className="settings-loading">Loading diff…</div> : threadId && state.selectedThreadId !== threadId ? <div className="settings-loading">Loading thread…</div> : <PaneContent kind={kind} diff={diff} standalone />}
      </div>
    </div>
  );
}
