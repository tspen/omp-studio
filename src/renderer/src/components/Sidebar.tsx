import React, { useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Folder,
  FolderGit2,
  GitBranch,
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
              expanded={expanded}
              onToggle={toggle}
              onSelect={(id) => void state.selectNode(id)}
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
  expanded,
  onToggle,
  onSelect,
  onNewNode,
  onNewThread,
}: {
  node: TreeNode;
  depth: number;
  nodes: TreeNode[];
  threads: Thread[];
  selectedId: string | null;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onNewNode: () => void;
  onNewThread: () => void;
}) {
  const children = childNodes(nodes, node.id);
  const isOpen = expanded[node.id] !== false;
  const status = aggregateStatus(threads, node.id);
  const running = threads.filter((thread) => thread.nodeId === node.id && thread.status === "running").length;
  const isSelected = selectedId === node.id;
  return (
    <div>
      <div className={cx("tree-row", isSelected && "active")} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(node.id)}>
        <button
          type="button"
          className={cx("tree-caret", !children.length && "hidden")}
          onClick={(event) => {
            event.stopPropagation();
            if (children.length) onToggle(node.id);
          }}
        >
          {children.length ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
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
      {isOpen && children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          nodes={nodes}
          threads={threads}
          selectedId={selectedId}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
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
