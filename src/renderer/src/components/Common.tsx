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
      <defs>
        <linearGradient id="wren-bg" x1="16" y1="1" x2="16" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2A2145" />
          <stop offset="1" stopColor="#15111D" />
        </linearGradient>
        <radialGradient id="wren-glow" cx="0" cy="0" r="1" gradientTransform="translate(13 11) rotate(90) scale(16)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6D5BFF" stopOpacity="0.35" />
          <stop offset="1" stopColor="#6D5BFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="wren-blue" x1="7" y1="8" x2="15" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9BC2FF" />
          <stop offset="0.5" stopColor="#5A87FF" />
          <stop offset="1" stopColor="#2F51D6" />
        </linearGradient>
        <linearGradient id="wren-tail" x1="18" y1="21" x2="28" y2="5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2B49C9" />
          <stop offset="0.55" stopColor="#4C7BFF" />
          <stop offset="1" stopColor="#9BC7FF" />
        </linearGradient>
        <linearGradient id="wren-wing" x1="12" y1="16" x2="23" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D08C60" />
          <stop offset="0.55" stopColor="#A95E3A" />
          <stop offset="1" stopColor="#743A27" />
        </linearGradient>
        <linearGradient id="wren-cream" x1="11" y1="20" x2="16" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F7E3C5" />
          <stop offset="1" stopColor="#D6AF86" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#wren-bg)" />
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#wren-glow)" />
      <path d="M18 21.2C21 16.4 24.8 11 28.4 5.6C27.3 12 24.8 18 20.8 22.4Z" fill="url(#wren-tail)" />
      <path d="M19.2 21.8C21.9 17.6 24.9 13.2 27.8 8.8C26.9 14 24.8 19 21.7 22.7Z" fill="#82AAFF" opacity="0.45" />
      <ellipse cx="16.6" cy="20.4" rx="6.4" ry="5.8" transform="rotate(-12 16.6 20.4)" fill="url(#wren-wing)" />
      <ellipse cx="13.6" cy="22.7" rx="3.5" ry="2.9" transform="rotate(-16 13.6 22.7)" fill="url(#wren-cream)" />
      <path d="M15.8 15.8C19.8 15.2 22.8 17.5 23.4 21C23.9 24 22 26.4 19.2 26.6C16.6 26.8 14.7 24.8 14.7 21.8C14.7 19.4 14.9 17.4 15.8 15.8Z" fill="#8E4A2E" />
      <path d="M16.3 17.1C19 16.7 21.1 18.2 21.7 20.7C22.2 22.9 20.8 24.8 18.7 25C16.6 25.1 15.2 23.6 15.2 21.4C15.2 19.7 15.4 18.3 16.3 17.1Z" fill="url(#wren-wing)" />
      <circle cx="11.4" cy="12.4" r="5.8" fill="url(#wren-blue)" />
      <path d="M5.8 12.3C7 9.8 9.5 8.2 12.3 8.2C14.4 8.2 16 9 17 10.3C17.3 10.7 17.2 11.2 16.8 11.5C15.6 12.4 14.1 12.7 12.7 12.4C10.9 12 9.1 12.5 7.7 13.7C6.9 13.3 6.2 12.9 5.8 12.3Z" fill="#121019" />
      <path d="M6.8 15.2C8.8 13.8 11.4 13.4 13.6 14.2C15.6 14.9 16.8 16.4 17.2 18.4C17.6 20.6 16.7 22.5 14.9 23.4C12.8 24.4 10.4 24 8.8 22.4C7.4 21 6.9 19.4 7.1 17.6C7.2 16.7 7 15.8 6.8 15.2Z" fill="#121019" />
      <path d="M7.6 13.7C9.4 12.4 11.4 12 13.3 12.6C14.4 12.9 15.3 13.5 15.9 14.4C14.2 14.8 12.8 15.7 11.7 17C10.1 16.2 8.8 15.1 7.6 13.7Z" fill="#6D9AFF" opacity="0.9" />
      <path d="M5.5 12.2L2.1 13.3L5.5 14.4Z" fill="#121019" />
      <circle cx="10.1" cy="10.9" r="0.9" fill="#FFFFFF" />
      <path d="M7.5 8.9C9.1 7.8 10.9 7.4 12.7 7.8" stroke="#BBD6FF" strokeWidth="0.55" strokeLinecap="round" opacity="0.5" />
      <path d="M18 20C19.8 19.8 21.2 20.8 21.8 22.2C22.3 23.4 22 24.7 21.2 25.5C20.4 23.6 19.3 21.9 18 21.2Z" fill="#4C7BFF" opacity="0.9" />
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
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href}
              title={href}
              onClick={(event) => {
                if (!href || !/^https?:\/\//i.test(href)) return;
                event.preventDefault();
                void window.perch.openBrowser(href);
              }}
            >
              {label}
            </a>
          ),
        }}
      >
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

export function slugName(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
  return base || "untitled";
}

/** Preview of the folder the host will create under the workspace root. */
export function defaultNodePath(name: string, workspaceRoot?: string): string {
  const root = (workspaceRoot ?? "").replace(/[\\/]+$/, "");
  if (!root || !name.trim()) return "";
  return `${root}\\${slugName(name)}`;
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
