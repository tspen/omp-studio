import { spawn } from "node:child_process";
import { pythonCommand } from "./python";
import type { AstEditInput, AstEditResult, AstGrepInput, AstResult } from "./ast";

const PYTHON_AST_HELPER = String.raw`
import ast
import json
import os
import re
import sys

META = "__perch_meta_"
IGNORED = {
    ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", "node_modules",
    "dist", "build", ".next", ".nuxt", "coverage", "out",
}

def meta_name(value):
    if isinstance(value, str) and value.startswith(META):
        return value[len(META):]
    return None

def is_meta_node(node):
    return isinstance(node, ast.Name) and node.id.startswith(META)

def meta_item_name(item):
    if isinstance(item, str):
        return meta_name(item)
    if is_meta_node(item):
        return meta_name(item.id)
    if isinstance(item, ast.Expr) and is_meta_node(item.value):
        return meta_name(item.value.id)
    return None

def source_lines(source):
    lines = source.splitlines(keepends=True)
    starts = []
    position = 0
    for line in lines:
        starts.append(position)
        position += len(line)
    if not lines:
        lines = [""]
        starts = [0]
    return lines, starts

def char_col(line, byte_col):
    if not line:
        return 0
    encoded = line.encode("utf-8")
    prefix = encoded[:max(0, int(byte_col or 0))]
    return len(prefix.decode("utf-8", "ignore"))

def node_start(lines, starts, node):
    index = max(0, int(getattr(node, "lineno", 1) or 1) - 1)
    index = min(index, len(lines) - 1)
    return starts[index] + char_col(lines[index], getattr(node, "col_offset", 0) or 0)

def node_end(lines, starts, node):
    index = max(0, int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1) - 1)
    index = min(index, len(lines) - 1)
    end_col = getattr(node, "end_col_offset", getattr(node, "col_offset", 0)) or 0
    return starts[index] + char_col(lines[index], end_col)

class Capture:
    def __init__(self, name, multiple=False, separator=", "):
        self.name = name
        self.multiple = multiple
        self.separator = separator
        self.parts = []
    def add(self, part):
        if part is None:
            return
        if self.multiple:
            self.parts.append(part)
        else:
            self.parts = [part]
    def text(self):
        if self.multiple:
            return self.separator.join(self.parts)
        return self.parts[0] if self.parts else ""
    def output(self):
        if self.multiple:
            return list(self.parts)
        return self.parts[0] if self.parts else ""

def capture_node(captures, name, text, multiple=False, separator=", "):
    capture = captures.get(name)
    if capture is None:
        capture = Capture(name, multiple, separator)
        captures[name] = capture
    capture.multiple = capture.multiple or multiple
    if multiple:
        capture.separator = separator
    capture.add(text)

def pattern_info(pattern):
    multiple = set(re.findall(r"\$\$\$([A-Za-z_]\w*)", pattern))
    named = set(re.findall(r"\$\$?([A-Za-z_]\w*)", pattern)) - multiple
    expanded = re.sub(r"\$\$\$([A-Za-z_]\w*)", lambda match: META + match.group(1), pattern)
    expanded = re.sub(r"\$\$?([A-Za-z_]\w*)", lambda match: META + match.group(1), expanded)
    try:
        tree = ast.parse(expanded, mode="eval")
        return tree.body, multiple, named
    except SyntaxError:
        tree = ast.parse(expanded, mode="exec")
        if len(tree.body) != 1:
            raise ValueError("Python AST patterns must be a single expression or statement")
        return tree.body[0], multiple, named

def match(pattern, target, captures, multiple, named):
    if isinstance(pattern, str):
        name = meta_name(pattern)
        if name:
            capture_node(captures, name, pattern, name in multiple)
            return True
        return isinstance(target, str) and pattern == target
    if is_meta_node(pattern):
        name = meta_name(pattern.id)
        capture_node(captures, name, target, name in multiple)
        return True
    if pattern is None or isinstance(pattern, (int, float, complex, bool, bytes)):
        return pattern == target
    if not isinstance(target, ast.AST) or type(pattern) is not type(target):
        return False
    if isinstance(pattern, ast.Call):
        return match_call(pattern, target, captures, multiple, named)
    for field in pattern._fields:
        if field in ("ctx", "type_comment"):
            continue
        pvalue = getattr(pattern, field, None)
        tvalue = getattr(target, field, None)
        if isinstance(pvalue, list):
            if not match_list(pvalue, tvalue, captures, multiple, named, field):
                return False
        elif not match(pvalue, tvalue, captures, multiple, named):
            return False
    return True

def match_call(pattern, target, captures, multiple, named):
    if not match(pattern.func, target.func, captures, multiple, named):
        return False
    variadic = None
    if len(pattern.args) == 1:
        name = meta_item_name(pattern.args[0])
        if name and name in multiple:
            variadic = name
    if variadic and not pattern.keywords:
        for item in target.args:
            capture_node(captures, variadic, item, True, ", ")
        for item in target.keywords:
            capture_node(captures, variadic, item, True, ", ")
        return True
    if not match_list(pattern.args, target.args, captures, multiple, named, "args"):
        return False
    if not match_list(pattern.keywords, target.keywords, captures, multiple, named, "keywords"):
        return False
    return True

def match_list(pattern_list, target_list, captures, multiple, named, field):
    if not isinstance(target_list, list):
        return False
    if len(pattern_list) == 1:
        name = meta_item_name(pattern_list[0])
        if name and name in multiple:
            separator = "\n" if field in ("body", "orelse", "finalbody") else ", "
            for target in target_list:
                capture_node(captures, name, target, True, separator)
            return True
    if len(pattern_list) != len(target_list):
        return False
    for pattern_item, target_item in zip(pattern_list, target_list):
        if not match(pattern_item, target_item, captures, multiple, named):
            return False
    return True

def capture_text(capture, source, lines, starts):
    parts = []
    for item in capture.parts:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, ast.AST):
            start = node_start(lines, starts, item)
            end = node_end(lines, starts, item)
            parts.append(source[start:end])
        else:
            parts.append(str(item))
    capture.parts = parts

def render_rewrite(rewrite, captures):
    def replace(match):
        name = match.group(1) or match.group(2)
        capture = captures.get(name)
        if capture is None:
            return match.group(0)
        return capture.text()
    return re.sub(r"\$\$\$([A-Za-z_]\w*)|\$\$?([A-Za-z_]\w*)", replace, rewrite)

def make_match(path, source, lines, starts, node, captures, rewrite):
    for capture in captures.values():
        capture_text(capture, source, lines, starts)
    start = node_start(lines, starts, node)
    end = node_end(lines, starts, node)
    start_line = max(0, int(getattr(node, "lineno", 1) or 1) - 1)
    end_line = max(0, int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1) - 1)
    item = {
        "path": path,
        "line": start_line + 1,
        "column": char_col(lines[start_line], getattr(node, "col_offset", 0) or 0) + 1,
        "endLine": end_line + 1,
        "endColumn": char_col(lines[end_line], getattr(node, "end_col_offset", getattr(node, "col_offset", 0)) or 0) + 1,
        "text": source[start:end],
        "captures": {name: capture.output() for name, capture in captures.items()},
        "_start": start,
        "_end": end,
    }
    if rewrite is not None:
        item["_replacement"] = render_rewrite(rewrite, captures)
    return item

def files_for(root, target):
    start = os.path.abspath(os.path.join(root, target or "."))
    if os.path.commonpath([root, start]) != root:
        raise ValueError("Path must be inside the project workspace")
    if os.path.isfile(start):
        return [start] if start.lower().endswith(".py") else []
    if not os.path.isdir(start):
        raise ValueError("Path not found: " + (target or "."))
    files = []
    for directory, dirnames, filenames in os.walk(start):
        dirnames[:] = [name for name in dirnames if name not in IGNORED]
        for name in filenames:
            if name.lower().endswith(".py"):
                files.append(os.path.join(directory, name))
    files.sort()
    return files

def run(payload):
    root = os.path.abspath(payload.get("cwd") or ".")
    pattern = payload.get("pattern") or ""
    if not pattern.strip():
        raise ValueError("A pattern is required")
    pattern_node, multiple, named = pattern_info(pattern)
    limit = max(1, min(1000, int(payload.get("limit") or 100)))
    rewrite = payload.get("rewrite")
    dry_run = bool(payload.get("dryRun"))
    matches = []
    changes = []
    errors = []
    parsed = 0
    truncated = False
    for file in files_for(root, payload.get("path")):
        if len(matches) >= limit or len(changes) >= limit:
            truncated = True
            break
        try:
            with open(file, "r", encoding="utf-8", newline="") as handle:
                source = handle.read()
        except Exception as error:
            errors.append({"path": os.path.relpath(file, root), "message": str(error)})
            continue
        try:
            tree = ast.parse(source, filename=file)
            parsed += 1
            lines, starts = source_lines(source)
            file_matches = []
            for node in ast.walk(tree):
                captures = {}
                if match(pattern_node, node, captures, multiple, named):
                    file_matches.append(make_match(os.path.relpath(file, root).replace(os.sep, "/"), source, lines, starts, node, captures, rewrite))
                    if len(matches) + len(changes) + len(file_matches) >= limit:
                        truncated = True
                        break
            if rewrite is not None:
                file_matches.sort(key=lambda item: (item["_start"], -(item["_end"] - item["_start"])))
                selected = []
                last_end = -1
                for item in file_matches:
                    if item["_start"] < last_end:
                        continue
                    selected.append(item)
                    last_end = item["_end"]
                if selected:
                    updated = source
                    for item in reversed(selected):
                        updated = updated[:item["_start"]] + item["_replacement"] + updated[item["_end"]:]
                    if not dry_run and updated != source:
                        with open(file, "w", encoding="utf-8", newline="") as handle:
                            handle.write(updated)
                    for item in selected:
                        item["text"] = item["_replacement"]
                        item.pop("_replacement", None)
                        item.pop("_start", None)
                        item.pop("_end", None)
                        changes.append(item)
                continue
            for item in file_matches:
                item.pop("_replacement", None)
                item.pop("_start", None)
                item.pop("_end", None)
            matches.extend(file_matches)
        except Exception as error:
            errors.append({"path": os.path.relpath(file, root), "message": str(error)})
    if rewrite is not None:
        return {"changes": changes, "files": parsed, "applied": not dry_run, "truncated": truncated, "errors": errors}
    return {"matches": matches, "files": parsed, "truncated": truncated, "errors": errors}

def main():
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(run(payload)))
    except Exception as error:
        print(json.dumps({"error": str(error)}))

if __name__ == "__main__":
    main()
`;

interface PythonAstPayload {
  cwd: string;
  path?: string;
  pattern: string;
  limit?: number;
  rewrite?: string;
  dryRun?: boolean;
}

function run(payload: PythonAstPayload): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    let command: { command: string; args: string[] };
    try {
      command = pythonCommand();
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const child = spawn(command.command, [...command.args, "-u", "-c", PYTHON_AST_HELPER], {
      cwd: payload.cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Python AST request timed out"));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`Python AST helper failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      try {
        const result = JSON.parse(line);
        if (result?.error) rejectPromise(new Error(String(result.error)));
        else resolvePromise(result);
      } catch (error) {
        rejectPromise(new Error(`Python AST helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.write(JSON.stringify(payload), "utf8");
    child.stdin.end();
  });
}

export async function pythonAstGrep(input: AstGrepInput): Promise<AstResult> {
  return run({
    cwd: input.cwd,
    path: input.path,
    pattern: input.pattern,
    limit: input.limit,
  });
}

export async function pythonAstEdit(input: AstEditInput): Promise<AstEditResult> {
  return run({
    cwd: input.cwd,
    path: input.path,
    pattern: input.pattern,
    rewrite: input.rewrite,
    dryRun: input.dryRun,
    limit: input.limit,
  });
}
