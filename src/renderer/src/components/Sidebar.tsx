import React, { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Folder,
  FolderGit2,
  GitBranch,
  Globe,
  Inbox,
  Layers,
  MoreHorizontal,
  Orbit,
  Plus,
  Search,
  Settings,
  Sparkles,
  TerminalSquare,
  TreePine,
  Zap,
} from "lucide-react";
import type { Thread, TreeNode } from "../../../shared/types";
import { useApp, childNodes, selectedNode, selectedThread } from "../store";
import { Badge, Button, IconButton, StatusDot, cx, formatCost, formatNumber, statusColor, statusLabel, truncate } from "./Common";

export function Sidebar() {
  const state = useApp();
  const snapshot = state.snapshot;
  const [menu, setMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);
  const nodes = snapshot?.nodes ?? [];
  const threads = snapshot?.threads ?? [];
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const root = nodes.find((item) => item.type === "root");
  const unread = state.notifications.filter((item) => !item.read).length;
  const inbox = state.inbox.length;

  const pinned = useMemo(() => nodes.filter((item) => item.parentId === root?.id).slice(0, 8), [nodes, root?.id]);
  const filteredNodes = useMemo(() => {
    if (!query.trim()) return nodes;
    const lower = query.toLowerCase();
    return nodes.filter((item) => item.name.toLowerCase().includes(lower));
  }, [nodes, query]);

  const toggle = (id: string) => setExpanded((current) => ({ ...current, [id]: current[id] === false ? true : false }));

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a project or group" />
      </div>

      <nav className="sidebar-nav">
        <NavItem icon={<Orbit size={16} />} label="Mission Control" active={node?.type === "root"} badge={inbox ? String(inbox) : undefined} onClick={() => void state.selectRoot()} />
        <NavItem icon={<Inbox size={16} />} label="Inbox" badge={inbox ? String(inbox) : undefined} onClick={() => state.setOverlay("inbox")} />
        <NavItem icon={<TreePine size={16} />} label="All threads" onClick={() => state.setOverlay("search")} />
        <NavItem icon={<Archive size={16} />} label="Artifacts" onClick={() => { void state.loadArtifacts(); state.setOverlay("artifacts"); }} />
        <NavItem icon={<Globe size={16} />} label="Sites" badge={state.sites.length ? String(state.sites.length) : undefined} onClick={() => { void state.loadSites(); state.setOverlay("sites"); }} />
        <NavItem icon={<TerminalSquare size={16} />} label="Terminal" onClick={() => { void state.loadTerminals(); state.setOverlay("terminal"); }} />
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-label">
          <span>Pinned</span>
          <ChevronDown size={13} />
        </div>
        <div className="pinned-list">
          {pinned.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx("pinned-row", state.selectedNodeId === item.id && "active")}
              onClick={() => void state.selectNode(item.id)}
            >
              <NodeIcon type={item.type} />
              <span>{item.name}</span>
              <StatusDot status={aggregateStatus(threads, item.id)} />
            </button>
          ))}
          {!pinned.length ? <p className="sidebar-empty">Create a group or project to begin.</p> : null}
        </div>
      </div>

      <div className="sidebar-section grow">
        <div className="sidebar-label">
          <span>Tree</span>
          <div className="sidebar-label-actions">
            <button type="button" className={cx("resolved-toggle", showResolved && "on")} title={showResolved ? "Hide resolved threads" : "Show resolved threads"} onClick={() => setShowResolved((value) => !value)}><Archive size={13} /></button>
            <IconButton icon={<Plus size={13} />} label="New group" onClick={() => state.setOverlay("new-node")} />
            <IconButton icon={<MoreHorizontal size={14} />} label="Settings" onClick={() => state.setSettingsTab("general")} />
          </div>
        </div>
        <div className="tree">
          {root ? (
            <TreeRow
              node={root}
              depth={0}
              nodes={filteredNodes}
              threads={threads}
              selectedId={state.selectedNodeId}
              selectedThreadId={state.selectedThreadId}
              showResolved={showResolved}
              expanded={expanded}
              onToggle={toggle}
              onSelect={(id) => void state.selectNode(id)}
              onSelectThread={(threadId, nodeId) => void state.selectThread(threadId, nodeId)}
              onThreadMenu={(threadId, x, y) => setMenu({ threadId, x, y })}
              onNewNode={() => state.setOverlay("new-node")}
              onNewThread={() => state.setOverlay("new-thread")}
            />
          ) : (
            <p className="sidebar-empty">Loading tree…</p>
          )}
        </div>
      </div>

      <div className="sidebar-foot">
        <div className="foot-row">
          <span className="foot-avatar">T</span>
          <div className="foot-user">
            <strong>Tim</strong>
            <span>{thread ? truncate(thread.model.name ?? thread.model.selector, 24) : "No thread"}</span>
          </div>
          <IconButton icon={<Settings size={15} />} label="Settings" onClick={() => state.setSettingsTab("general")} />
        </div>
        <div className="foot-stats">
          <span><Zap size={12} /> {formatNumber(snapshot?.usage.totalTokens ?? 0)} tokens</span>
          <span><CircleDollarSign size={12} /> {formatCost(snapshot?.usage.totalCost ?? 0)}</span>
          <span className={cx("engine-pill", state.engine?.found ? "ok" : "bad")}>{state.engine?.found ? "OMP" : "No engine"}</span>
        </div>
        {thread ? (
          <div className="foot-thread">
            <StatusDot status={thread.status} pulse={thread.status === "running"} />
            <span>{statusLabel(thread.status)}</span>
            {thread.git?.branch ? <span className="foot-branch"><GitBranch size={11} /> {thread.git.branch}</span> : null}
          </div>
        ) : null}
      </div>

      {menu ? (() => {
        const target = snapshot?.threads.find((item) => item.id === menu.threadId);
        if (!target) return null;
        return (
          <div className="thread-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => { setMenu(null); void state.selectThread(target.id, target.nodeId); }}>Open thread</button>
            {target.archived ? (
              <button
                type="button"
                onClick={async () => {
                  setMenu(null);
                  try {
                    await window.omp.updateThread(target.id, { archived: false, status: "idle", statusMessage: "Reopened" });
                    await state.refresh();
                    state.pushToast({ kind: "info", title: "Thread reopened", body: target.title });
                  } catch (error) {
                    state.pushToast({ kind: "error", title: "Could not reopen thread", body: String(error) });
                  }
                }}
              >
                Reopen
              </button>
            ) : (
              <button type="button" onClick={() => { setMenu(null); void state.resolveThread(target.id); }}>Resolve</button>
            )}
            <button
              type="button"
              className="danger"
              onClick={async () => {
                setMenu(null);
                if (!confirm(`Delete thread "${target.title}"? Its branch and files stay on disk.`)) return;
                try {
                  await window.omp.deleteThread(target.id);
                  await state.refresh();
                  state.pushToast({ kind: "info", title: "Thread deleted", body: target.title });
                } catch (error) {
                  state.pushToast({ kind: "error", title: "Could not delete thread", body: String(error) });
                }
              }}
            >
              Delete thread
            </button>
          </div>
        );
      })() : null}
    </aside>
  );
}

function NavItem({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cx("nav-item", active && "active")} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge ? <Badge tone="accent">{badge}</Badge> : null}
    </button>
  );
}

function TreeRow({
  node,
  depth,
  nodes,
  threads,
  selectedId,
  selectedThreadId,
  showResolved,
  expanded,
  onToggle,
  onSelect,
  onSelectThread,
  onThreadMenu,
  onNewNode,
  onNewThread,
}: {
  node: TreeNode;
  depth: number;
  nodes: TreeNode[];
  threads: Thread[];
  selectedId: string | null;
  selectedThreadId: string | null;
  showResolved: boolean;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSelectThread: (threadId: string, nodeId: string) => void;
  onThreadMenu: (threadId: string, x: number, y: number) => void;
  onNewNode: () => void;
  onNewThread: () => void;
}) {
  const children = childNodes(nodes, node.id);
  const isOpen = expanded[node.id] !== false;
  const status = aggregateStatus(threads, node.id);
  const running = threads.filter((thread) => thread.nodeId === node.id && thread.status === "running").length;
  const isSelected = selectedId === node.id;
  const childThreads = threads
    .filter((thread) => thread.nodeId === node.id && thread.kind !== "orchestrator" && (showResolved || !thread.archived || ["running", "starting", "waiting", "queued"].includes(thread.status)))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  return (
    <div>
      <div className={cx("tree-row", isSelected && "active")} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(node.id)}>
        <button
          type="button"
          className={cx("tree-caret", !children.length && !childThreads.length && "hidden")}
          onClick={(event) => {
            event.stopPropagation();
            if (children.length || childThreads.length) onToggle(node.id);
          }}
        >
          {children.length || childThreads.length ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </button>
        <NodeIcon type={node.type} />
        <span className="tree-name">{node.name}</span>
        {running ? <span className="tree-running">{running}</span> : null}
        <StatusDot status={status} pulse={status === "running"} />
        <div className="tree-actions">
          {node.type !== "project" ? (
            <IconButton icon={<Plus size={12} />} label="New child group/project" onClick={() => { onSelect(node.id); onNewNode(); }} />
          ) : (
            <IconButton icon={<Plus size={12} />} label="New thread" onClick={() => { onSelect(node.id); onNewThread(); }} />
          )}
        </div>
      </div>
      {isOpen ? childThreads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          className={cx("tree-thread", thread.id === selectedThreadId && "active", thread.archived && "resolved")}
          data-thread-id={thread.id}
          style={{ paddingLeft: 20 + (depth + 1) * 14 }}
          title={`${thread.title} · ${thread.status}${thread.statusMessage ? ` · ${thread.statusMessage}` : ""}${thread.git?.branch ? ` · ${thread.git.branch}` : ""}`}
          onClick={(event) => { event.stopPropagation(); onSelectThread(thread.id, node.id); }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onThreadMenu(thread.id, event.clientX, event.clientY);
          }}
        >
          <StatusDot status={thread.status} pulse={thread.status === "running" || thread.status === "starting"} />
          <span className="tree-thread-name">{thread.title}</span>
          {thread.git?.branch ? <GitBranch size={10} className="tree-thread-branch" /> : null}
          {thread.tokens ? <span className="tree-thread-tokens">{formatNumber(thread.tokens)}</span> : null}
        </button>
      )) : null}
      {isOpen && children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          nodes={nodes}
          threads={threads}
          selectedId={selectedId}
          selectedThreadId={selectedThreadId}
          showResolved={showResolved}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          onSelectThread={onSelectThread}
          onThreadMenu={onThreadMenu}
          onNewNode={onNewNode}
          onNewThread={onNewThread}
        />
      ))}
    </div>
  );
}

function NodeIcon({ type }: { type: TreeNode["type"] }) {
  if (type === "root") return <Orbit size={15} className="node-icon root" />;
  if (type === "group") return <Boxes size={15} className="node-icon group" />;
  return <FolderGit2 size={15} className="node-icon project" />;
}

function aggregateStatus(threads: Thread[], nodeId: string): Thread["status"] {
  const list = threads.filter((thread) => thread.nodeId === nodeId);
  if (list.some((thread) => thread.status === "error")) return "error";
  if (list.some((thread) => thread.status === "waiting" || thread.pendingApproval)) return "waiting";
  if (list.some((thread) => thread.status === "running" || thread.status === "starting")) return "running";
  if (list.some((thread) => thread.status === "completed")) return "completed";
  return "idle";
}
