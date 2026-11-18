/**
 * electron-builder beforePack hook.
 *
 * The Pi schema package ships an @oh-my-pi devDependency name in its
 * published package.json. It is not installed or used at runtime, but it is
 * copied into the unpacked vendor tree. Replace the stale dev-only name so the
 * shipped app carries no legacy brand tokens.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function beforePack() {
  const file = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-schema", "package.json");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const next = text.replaceAll("@oh-my-pi/omptype", "@earendil-works/omptype");
  if (next !== text) fs.writeFileSync(file, next, "utf8");
};
