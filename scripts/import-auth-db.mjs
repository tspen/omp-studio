import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultTarget() {
  const base = process.env.PERCH_USER_DATA || process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(base, "Perch", "pi-agent", "auth.json");
}

function migrate(row) {
  if (row.disabled_cause) return undefined;
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return undefined;
  }
  if (row.credential_type === "api_key") {
    if (!data || typeof data.key !== "string" || !data.key) return undefined;
    return { type: "api_key", key: data.key };
  }
  if (row.credential_type === "oauth") {
    if (!data || typeof data.access !== "string" || typeof data.refresh !== "string") return undefined;
    const expires = Number(data.expires);
    if (!Number.isFinite(expires)) return undefined;
    return {
      ...data,
      // Pi stores absolute expiry in milliseconds. Legacy stores use seconds.
      expires: expires < 1_000_000_000_000 ? expires * 1000 : expires,
      type: "oauth",
    };
  }
  return undefined;
}

const dbPath = argument("--db") || process.env.PERCH_LEGACY_AUTH_DB;
if (!dbPath) {
  console.error("Usage: node scripts/import-auth-db.mjs --db <agent.db> [--target <auth.json>] [--force]");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`Auth database not found: ${dbPath}`);
  process.exit(1);
}
const target = argument("--target") || defaultTarget();
const force = process.argv.includes("--force");

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare("SELECT provider, credential_type, data, disabled_cause FROM auth_credentials").all();
db.close();

let auth = {};
if (existsSync(target)) {
  try {
    auth = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    auth = {};
  }
}

let imported = 0;
let skipped = 0;
for (const row of rows) {
  const credential = migrate(row);
  if (!credential) {
    skipped += 1;
    continue;
  }
  if (auth[row.provider] && !force) {
    skipped += 1;
    continue;
  }
  auth[row.provider] = credential;
  imported += 1;
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
writeFileSync(target, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ target, imported, skipped, providers: Object.keys(auth) }, null, 2));
