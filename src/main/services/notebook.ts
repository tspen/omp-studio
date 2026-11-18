import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { PythonResult, PythonService } from "./python";

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: any[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  id?: string;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export interface NotebookRequest {
  action: "read" | "execute" | "insert" | "update" | "delete" | "clear";
  cwd: string;
  path: string;
  index?: number;
  source?: string;
  cellType?: "code" | "markdown" | "raw";
  save?: boolean;
  timeoutMs?: number;
  threadId: string;
}

function resolveNotebook(cwd: string, path: string): string {
  if (!path.trim()) throw new Error("A notebook path is required");
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  if (extname(file).toLowerCase() !== ".ipynb") throw new Error("Notebook path must end with .ipynb");
  return file;
}

function loadNotebook(path: string): Notebook {
  if (!existsSync(path)) throw new Error(`Notebook not found: ${path}`);
  let notebook: Notebook;
  try {
    notebook = JSON.parse(readFileSync(path, "utf8")) as Notebook;
  } catch (error) {
    throw new Error(`Notebook is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(notebook.cells)) throw new Error("Notebook has no cells array");
  return notebook;
}

function saveNotebook(path: string, notebook: Notebook): void {
  writeFileSync(path, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");
}

function sourceText(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
}

function summarizeOutput(output: any): Record<string, unknown> {
  if (output?.output_type === "stream") {
    return { type: "stream", name: output.name, text: Array.isArray(output.text) ? output.text.join("") : String(output.text ?? "") };
  }
  if (output?.output_type === "error") {
    return { type: "error", text: Array.isArray(output.traceback) ? output.traceback.join("\n") : String(output.evalue ?? "") };
  }
  if (output?.output_type === "execute_result" || output?.output_type === "display_data") {
    const data = output.data ?? {};
    return {
      type: output.output_type,
      text: Array.isArray(data["text/plain"]) ? data["text/plain"].join("") : String(data["text/plain"] ?? ""),
    };
  }
  return { type: String(output?.output_type ?? "unknown") };
}

function outputsFor(result: PythonResult): any[] {
  const outputs: any[] = [];
  if (result.stdout) outputs.push({ output_type: "stream", name: "stdout", text: result.stdout });
  if (result.stderr) outputs.push({ output_type: "stream", name: "stderr", text: result.stderr });
  if (result.result) {
    outputs.push({
      output_type: "execute_result",
      execution_count: null,
      data: { "text/plain": result.result },
      metadata: {},
    });
  }
  return outputs;
}

function cellSummary(cell: NotebookCell, index: number): Record<string, unknown> {
  return {
    index,
    type: cell.cell_type,
    source: sourceText(cell),
    outputs: (cell.outputs ?? []).map(summarizeOutput),
  };
}

function assertIndex(notebook: Notebook, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= notebook.cells.length) {
    throw new Error(`Cell index ${index} is out of range (0-${Math.max(0, notebook.cells.length - 1)})`);
  }
}

export async function notebookRequest(input: NotebookRequest, python: PythonService): Promise<any> {
  const path = resolveNotebook(input.cwd, input.path);
  const notebook = loadNotebook(path);
  const save = input.save !== false;

  if (input.action === "read") {
    return { path, cells: notebook.cells.map(cellSummary) };
  }

  if (input.action === "execute") {
    const requested = input.index == null ? notebook.cells.map((cell, index) => (cell.cell_type === "code" ? index : -1)).filter((index) => index >= 0) : [input.index];
    if (!requested.length) throw new Error("Notebook has no code cells to execute");
    const results: any[] = [];
    let executionCount = 0;
    for (const index of requested) {
      assertIndex(notebook, index);
      const cell = notebook.cells[index];
      if (cell.cell_type !== "code") throw new Error(`Cell ${index} is ${cell.cell_type}, not code`);
      const source = sourceText(cell);
      if (!source.trim()) {
        cell.outputs = [];
        results.push({ index, stdout: "", stderr: "", result: null });
        continue;
      }
      executionCount += 1;
      const result = await python.execute(`notebook:${input.threadId}:${path}`, input.cwd, source, input.timeoutMs);
      cell.outputs = outputsFor(result);
      cell.execution_count = executionCount;
      results.push({ index, ...result });
    }
    if (save) saveNotebook(path, notebook);
    return { path, saved: save, results };
  }

  if (input.action === "insert") {
    const index = input.index == null ? notebook.cells.length : input.index;
    if (!Number.isInteger(index) || index < 0 || index > notebook.cells.length) {
      throw new Error(`Cell index ${index} is out of range (0-${notebook.cells.length})`);
    }
    const source = String(input.source ?? "");
    notebook.cells.splice(index, 0, {
      cell_type: input.cellType ?? "code",
      source,
      outputs: [],
      execution_count: null,
      metadata: {},
    });
    if (save) saveNotebook(path, notebook);
    return { path, saved: save, cells: notebook.cells.map(cellSummary) };
  }

  if (input.action === "update") {
    const index = Number(input.index);
    assertIndex(notebook, index);
    if (input.source == null) throw new Error("update needs source");
    const cell = notebook.cells[index];
    cell.source = String(input.source);
    cell.outputs = [];
    cell.execution_count = null;
    if (save) saveNotebook(path, notebook);
    return { path, saved: save, cell: cellSummary(cell, index) };
  }

  if (input.action === "delete") {
    const index = Number(input.index);
    assertIndex(notebook, index);
    notebook.cells.splice(index, 1);
    if (save) saveNotebook(path, notebook);
    return { path, saved: save, cells: notebook.cells.map(cellSummary) };
  }

  if (input.action === "clear") {
    if (input.index == null) {
      for (const cell of notebook.cells) {
        cell.outputs = [];
        if (cell.cell_type === "code") cell.execution_count = null;
      }
    } else {
      const index = Number(input.index);
      assertIndex(notebook, index);
      notebook.cells[index].outputs = [];
      if (notebook.cells[index].cell_type === "code") notebook.cells[index].execution_count = null;
    }
    if (save) saveNotebook(path, notebook);
    return { path, saved: save, cells: notebook.cells.map(cellSummary) };
  }

  throw new Error(`Unsupported notebook action: ${String(input.action)}`);
}
