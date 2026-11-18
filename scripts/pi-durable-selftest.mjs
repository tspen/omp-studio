import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

const rootDir = mkdtempSync(join(tmpdir(), "perch-durable-"));
const faux = fauxProvider({ models: [{ id: "mock", name: "Mock", reasoning: false }] });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.models[0];

let harness;
let answer;
let reopenedAnswer;
try {
  const storage = await openNodeJsonlStorage(join(rootDir, "session"), BACKGROUND_CONTEXT);
  harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });

  faux.setResponses([fauxAssistantMessage("PERCH DURABLE OK")]);
  const submission = await root.submit({ type: "input", content: "Reply with PERCH DURABLE OK" }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done" || settled.type !== "input") throw new Error("durable submission did not settle");
  answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  harness = null;

  const reopenedStorage = await openNodeJsonlStorage(join(rootDir, "session"), BACKGROUND_CONTEXT);
  harness = await Harness.open(reopenedStorage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const reopened = await harness.root(BACKGROUND_CONTEXT);
  const page = await reopened.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  reopenedAnswer = page.items.some((entry) => JSON.stringify(entry).includes("PERCH DURABLE OK")) ? "PERCH DURABLE OK" : "";
  await harness.close(BACKGROUND_CONTEXT);
  harness = null;
} finally {
  if (harness) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  try {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* temp cleanup is best effort */
  }
}

const ok = reopenedAnswer === "PERCH DURABLE OK";
console.log(JSON.stringify({ ok, answer, reopenedAnswer }, null, 2));
process.exitCode = ok ? 0 : 1;





