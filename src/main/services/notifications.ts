import { Notification, nativeImage, shell, Tray, Menu, app } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppEvent, AppNotification } from "../../shared/types";
import type { Store } from "./store";

export class NotificationService {
  private store: Store;
  private emit: (event: AppEvent) => void;
  private onOpen?: (notification: AppNotification) => void;
  private onFocus?: () => void;
  private tray: Tray | null = null;
  private recent = new Map<string, number>();

  constructor(store: Store, emit: (event: AppEvent) => void) {
    this.store = store;
    this.emit = emit;
  }

  setOpenHandler(handler: (notification: AppNotification) => void): void {
    this.onOpen = handler;
  }

  setFocusHandler(handler: () => void): void {
    this.onFocus = handler;
  }

  createTray(iconPath: string): void {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 20, height: 20 }));
      this.tray.setToolTip("Perch");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Perch", click: () => this.onFocus?.() },
          { type: "separator" },
          { label: "Quit", click: () => app.quit() },
        ]),
      );
      this.tray.on("click", () => this.onFocus?.());
    } catch {
      this.tray = null;
    }
  }

  notify(input: {
    kind: AppNotification["kind"];
    title: string;
    body: string;
    nodeId?: string;
    threadId?: string;
  }): AppNotification {
    const notification: AppNotification = {
      id: `ntf_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: input.kind,
      title: input.title,
      body: input.body,
      nodeId: input.nodeId,
      threadId: input.threadId,
      read: false,
      createdAt: Date.now(),
    };
    this.store.addNotification(notification);
    this.emit({ type: "notification:new", payload: notification });

    const settings = this.store.settings.notifications;
    const node = input.nodeId ? this.store.getNode(input.nodeId) : undefined;
    const muted = !settings.enabled || !!node?.muted || (input.nodeId ? settings.mutedNodeIds.includes(input.nodeId) : false);
    const kindEnabled =
      (input.kind === "thread_completed" && settings.onComplete) ||
      (input.kind === "input_required" && settings.onQuestion) ||
      (input.kind === "error" && settings.onError) ||
      (input.kind === "digest" && settings.onDigest) ||
      ["usage_limit", "merge_conflict", "engine", "memory", "system"].includes(input.kind);

    const dedupeKey = `${input.kind}:${input.threadId ?? input.nodeId ?? ""}:${input.title}`;
    const now = Date.now();
    const last = this.recent.get(dedupeKey);
    if (last && now - last < 6000) return notification;
    this.recent.set(dedupeKey, now);
    if (this.recent.size > 200) this.recent.clear();

    if (!muted && kindEnabled && settings.toast && Notification.isSupported()) {
      try {
        const native = new Notification({ title: input.title, body: input.body, silent: !settings.sound });
        native.on("click", () => this.onOpen?.(notification));
        native.show();
      } catch {
        /* in-app notification still exists */
      }
    }
    if (!muted && kindEnabled && settings.sound) {
      try {
        shell.beep();
      } catch {
        /* ignore */
      }
    }
    this.updateTray();
    return notification;
  }

  list(): AppNotification[] {
    return this.store.data.notifications;
  }

  markRead(id: string): void {
    this.store.markNotificationRead(id);
    this.updateTray();
  }

  markAllRead(): void {
    this.store.markAllNotificationsRead();
    this.updateTray();
  }

  clear(): void {
    this.store.clearNotifications();
    this.updateTray();
  }

  updateTray(): void {
    if (!this.tray) return;
    const unread = this.store.data.notifications.filter((n) => !n.read).length;
    this.tray.setToolTip(unread ? `Perch — ${unread} unread` : "Perch");
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private placeholder(): AppNotification {
    return {
      id: "tray",
      kind: "system",
      title: "Perch",
      body: "",
      read: true,
      createdAt: Date.now(),
    };
  }
}
