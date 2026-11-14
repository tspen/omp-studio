import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  Envelope,
  EnvelopeKind,
  Priority,
  Thread,
  Trace,
  TreeNode,
} from "../../shared/types";
import type { Store } from "../services/store";

export interface SendEnvelopeInput {
  fromThreadId: string;
  fromNodeId?: string;
  toThreadId?: string;
  toNodeId?: string;
  kind: EnvelopeKind;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
  priority?: Priority;
  requiresResponse?: boolean;
  traceId?: string;
  parentEnvelopeId?: string;
  rootVisible?: boolean;
  deliver?: boolean;
}

export interface MessageBusDeps {
  store: Store;
  deliver: (envelope: Envelope) => Promise<boolean>;
  notifyQuestion: (envelope: Envelope) => void;
}

export class MessageBus extends EventEmitter {
  private store: Store;
  private deps: MessageBusDeps;
  private pendingQuestions = new Map<string, { envelope: Envelope; resolve: (answer: Envelope) => void }>();

  constructor(deps: MessageBusDeps) {
    super();
    this.store = deps.store;
    this.deps = deps;
  }

  createTrace(input: { title: string; prompt: string; nodeId: string; threadId: string }): Trace {
    const now = Date.now();
    const trace: Trace = {
      id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title: input.title,
      prompt: input.prompt,
      originNodeId: input.nodeId,
      originThreadId: input.threadId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.store.addTrace(trace);
  }

  async send(input: SendEnvelopeInput): Promise<Envelope> {
    const synthetic = input.fromThreadId === "user" || input.fromThreadId === "system";
    const fromThread = synthetic ? undefined : this.store.getThread(input.fromThreadId);
    if (!synthetic && !fromThread) throw new Error(`Sender thread not found: ${input.fromThreadId}`);
    const toThread = this.resolveTarget(input, fromThread);
    if (!toThread) throw new Error("Could not resolve message target");
    const fromNode = fromThread
      ? this.store.getNode(fromThread.nodeId)
      : input.fromNodeId
        ? this.store.getNode(input.fromNodeId)
        : undefined;
    const toNode = this.store.getNode(toThread.nodeId);
    const direction = fromThread ? this.threadDirection(fromThread, toThread) : "down";
    const now = Date.now();
    const envelope: Envelope = {
      id: `env_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      traceId: input.traceId ?? fromThread?.traceId ?? `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      fromThreadId: input.fromThreadId,
      toThreadId: toThread.id,
      fromNodeId: fromNode?.id,
      toNodeId: toNode?.id,
      direction,
      kind: input.kind,
      priority: input.priority ?? "normal",
      subject: input.subject.slice(0, 200),
      body: input.body,
      payload: input.payload,
      status: "queued",
      requiresResponse: !!input.requiresResponse,
      parentEnvelopeId: input.parentEnvelopeId,
      rootVisible: input.rootVisible !== false,
      createdAt: now,
    };
    this.store.appendEnvelope(envelope);
    this.emit("new", envelope);

    if (input.deliver !== false) {
      const delivered = await this.deps.deliver(envelope);
      envelope.status = delivered ? "delivered" : "queued";
      if (delivered) envelope.deliveredAt = Date.now();
      this.store.appendEnvelope(envelope);
      this.emit("updated", envelope);
    }

    if (input.requiresResponse) {
      this.deps.notifyQuestion(envelope);
    }
    return envelope;
  }

  async askParent(
    fromThreadId: string,
    question: string,
    context?: string,
    timeoutMs = 15 * 60_000,
  ): Promise<Envelope | null> {
    const fromThread = this.store.getThread(fromThreadId);
    if (!fromThread) throw new Error("Thread not found");
    const parent = this.parentOf(fromThread);
    if (!parent) return null;
    const envelope = await this.send({
      fromThreadId,
      toThreadId: parent.id,
      kind: "question",
      subject: question.slice(0, 120),
      body: context ? `${question}\n\nContext:\n${context}` : question,
      requiresResponse: true,
      priority: "high",
    });
    return new Promise<Envelope | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(envelope.id);
        resolve(null);
      }, timeoutMs);
      this.pendingQuestions.set(envelope.id, {
        envelope,
        resolve: (answer) => {
          clearTimeout(timer);
          this.pendingQuestions.delete(envelope.id);
          resolve(answer);
        },
      });
      this.emit("question", envelope);
    });
  }

  async answer(envelopeId: string, body: string, fromThreadId: string): Promise<Envelope> {
    const original = this.store.getEnvelope(envelopeId);
    if (!original) throw new Error("Message not found");
    const pending = this.pendingQuestions.get(original.id);
    const answer = await this.send({
      fromThreadId,
      toThreadId: original.fromThreadId,
      kind: "answer",
      subject: `Re: ${original.subject}`,
      body,
      parentEnvelopeId: original.id,
      traceId: original.traceId,
      priority: "high",
      deliver: !pending,
    });
    if (pending) {
      answer.status = "delivered";
      answer.deliveredAt = Date.now();
      this.store.appendEnvelope(answer);
      this.emit("updated", answer);
    }
    original.status = "answered";
    original.answeredAt = Date.now();
    this.store.appendEnvelope(original);
    this.emit("updated", original);
    if (pending) pending.resolve(answer);
    return answer;
  }

  markRead(envelopeId: string): void {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) return;
    if (envelope.status === "delivered" || envelope.status === "queued") {
      envelope.status = "read";
      envelope.readAt = Date.now();
      this.store.appendEnvelope(envelope);
      this.emit("updated", envelope);
    }
  }

  markDelivered(envelope: Envelope): void {
    if (envelope.status === "queued") {
      envelope.status = "delivered";
      envelope.deliveredAt = Date.now();
      this.store.appendEnvelope(envelope);
      this.emit("updated", envelope);
    }
  }

  pendingFor(threadId: string): Envelope[] {
    return this.store.inboxFor(threadId).filter((envelope) => envelope.requiresResponse);
  }

  formatForPrompt(envelope: Envelope, recipient: Thread): string {
    const fromThread = this.store.getThread(envelope.fromThreadId);
    const fromNode = fromThread ? this.store.getNode(fromThread.nodeId) : undefined;
    const toNode = this.store.getNode(recipient.nodeId);
    const fromLabel = envelope.fromThreadId === "user" ? "You" : fromThread?.title ?? "system";
    const fromNodeLabel = envelope.fromThreadId === "user" ? "the user" : fromNode?.name ?? "unknown";
    const lines = [
      `[TREE MESSAGE id=${envelope.id} trace=${envelope.traceId} kind=${envelope.kind} direction=${envelope.direction} priority=${envelope.priority}]`,
      `From: ${fromLabel} (${fromNodeLabel})`,
      `To: ${recipient.title} (${toNode?.name ?? "unknown"})`,
      `Subject: ${envelope.subject}`,
      `Requires response: ${envelope.requiresResponse ? "YES — reply with tree_reply using messageId " + envelope.id : "no"}`,
      "",
      envelope.body,
    ];
    return lines.join("\n");
  }

  parentOf(thread: Thread): Thread | undefined {
    if (thread.parentThreadId) return this.store.getThread(thread.parentThreadId);
    const node = this.store.getNode(thread.nodeId);
    if (!node?.parentId) return undefined;
    const parentNode = this.store.getNode(node.parentId);
    return parentNode ? this.store.getThread(parentNode.orchestratorThreadId) : undefined;
  }

  childrenOf(thread: Thread): Thread[] {
    return this.store.threads.filter((candidate) => candidate.parentThreadId === thread.id);
  }

  nodeThread(node: TreeNode): Thread | undefined {
    return this.store.getThread(node.orchestratorThreadId);
  }

  direction(fromNodeId: string, toNodeId: string): Envelope["direction"] {
    if (fromNodeId === toNodeId) return "lateral";
    if (this.isDescendant(toNodeId, fromNodeId)) return "down";
    if (this.isDescendant(fromNodeId, toNodeId)) return "up";
    return "lateral";
  }

  threadDirection(fromThread: Thread, toThread: Thread): Envelope["direction"] {
    if (fromThread.id === toThread.id) return "lateral";
    if (this.isThreadAncestor(toThread.id, fromThread.id)) return "up";
    if (this.isThreadAncestor(fromThread.id, toThread.id)) return "down";
    return this.direction(fromThread.nodeId, toThread.nodeId);
  }

  isThreadAncestor(ancestorId: string, descendantId: string): boolean {
    let current = this.store.getThread(descendantId);
    let guard = 0;
    while (current?.parentThreadId && guard++ < 100) {
      if (current.parentThreadId === ancestorId) return true;
      current = this.store.getThread(current.parentThreadId);
    }
    return false;
  }

  isDescendant(nodeId: string, ancestorId: string): boolean {
    let current = this.store.getNode(nodeId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.store.getNode(current.parentId);
    }
    return false;
  }

  private resolveTarget(input: SendEnvelopeInput, fromThread?: Thread): Thread | undefined {
    if (input.toThreadId) return this.store.getThread(input.toThreadId);
    if (input.toNodeId) {
      const node = this.store.getNode(input.toNodeId);
      return node ? this.store.getThread(node.orchestratorThreadId) : undefined;
    }
    return undefined;
  }
}
