import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  Loader2,
  X,
} from "lucide-react";
import type { ThreadStatus } from "../../../shared/types";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#g)" />
      <path d="M10 22V13.5C10 12.1 11.1 11 12.5 11H16" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 11V21" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="22" r="2.3" fill="white" />
      <circle cx="16" cy="11" r="2.3" fill="white" />
      <circle cx="16" cy="22" r="2.3" fill="white" />
      <circle cx="22" cy="11" r="2.3" fill="white" />
      <path d="M16 11H22" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <defs>
        <linearGradient id="g" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7a68ff" />
          <stop offset="1" stopColor="#4a3ac0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  disabled,
  title,
  type = "button",
  className,
}: {
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent) => void;
  variant?: "primary" | "ghost" | "soft" | "danger" | "outline";
  size?: "sm" | "md" | "lg" | "icon";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx("btn", `btn-${variant}`, `btn-${size}`, className)}
    >
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx("icon-btn", active && "active", danger && "danger")}
    >
      {icon}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "green" | "amber" | "red" | "blue" | "purple";
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cx("badge", `badge-${tone}`, className)}>
      {children}
    </span>
  );
}

export function StatusDot({ status, pulse }: { status: ThreadStatus | "root" | "group" | "project"; pulse?: boolean }) {
  const color = statusColor(status);
  return <span className={cx("status-dot", pulse && "pulse")} style={{ background: color }} />;
}

export function statusColor(status: ThreadStatus | "root" | "group" | "project" | string): string {
  switch (status) {
    case "running":
      return "var(--blue)";
    case "starting":
    case "queued":
      return "var(--amber)";
    case "waiting":
      return "var(--purple)";
    case "completed":
      return "var(--green)";
    case "error":
      return "var(--red)";
    case "cancelled":
      return "var(--muted)";
    case "parked":
      return "var(--muted-2)";
    case "root":
      return "var(--accent)";
    case "group":
      return "var(--blue)";
    case "project":
      return "var(--green)";
    default:
      return "var(--muted-2)";
  }
}

export function statusLabel(status: ThreadStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    case "cancelled":
      return "Stopped";
    case "parked":
      return "Parked";
    default:
      return status;
  }
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />;
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : <CircleDot size={26} />}
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = 680,
  footer,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={cx("modal", className)} style={{ width }} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton icon={<X size={17} />} label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("field", className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx("toggle", checked && "on")} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx(option.value === value && "active")}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cx("select-wrap", className)}>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={14} />
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length).trim()}…` : value;
}

export function Toasts({
  toasts,
  dismiss,
}: {
  toasts: Array<{ id: string; kind: "info" | "success" | "error" | "warning"; title: string; body?: string }>;
  dismiss: (id: string) => void;
}) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={cx("toast", `toast-${toast.kind}`)}>
          <div className="toast-icon">
            {toast.kind === "success" ? <Check size={15} /> : toast.kind === "error" || toast.kind === "warning" ? <AlertTriangle size={15} /> : <Circle size={12} />}
          </div>
          <div className="toast-copy">
            <strong>{toast.title}</strong>
            {toast.body ? <span>{toast.body}</span> : null}
          </div>
          <IconButton icon={<X size={13} />} label="Dismiss" onClick={() => dismiss(toast.id)} />
        </div>
      ))}
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
