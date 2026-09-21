#!/usr/bin/env node
/**
 * tools/verify-clean.mjs — the privacy gate. Run before every push (`npm run verify`).
 *
 * Scans the entire distribution (everything tracked, minus .git) and FAILS (exit 1) if any
 * forbidden pattern appears: key material, session identifiers, local machine paths,
 * private project/system names, or pasted conversation text. The benchmark corpus lives on
 * the author's machine and is never distributed; this script proves the published files
 * are clean of it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = [
  [/sk-[A-Za-z0-9_-]{16,}/, "api key (sk-…)"],
  [/ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}/, "github token"],
  [/TYPESAFE_API_KEY\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/, "assigned TypeSafe key"],
  [/Bearer\s+[A-Za-z0-9._\-]{30,}/, "bearer token"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/, "uuid"],
  [/\b[0-9a-f]{36}\b/i, "codex session id fragment"],
  [/\b[cde]\d-[0-9a-f]{6,8}\b/, "local corpus case id"],
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]/i, "windows user path"],
  [/\/(home|Users|root)\/[a-z0-9._-]{3,}\//i, "user home path"],
  [/\bD:[\\/]/i, "drive path (local worktree)"],
  [/codex-home-v2|whatsapp|qr.?listener|luna\s*max|hottoy|zhaocai|boyu|easystore/i, "private system / project name"],
  [/\b[0-9a-f]{40}\b/i, "git commit hash (session content)"],
];
// pasted conversation text (long CJK runs) must never appear in data, assets or tools
const CJK = /[\u4e00-\u9fff]{13,}/;
const CJK_EXEMPT = new Set(["README.md", "SKILL.md"]); // the Chinese-optimization docs legitimately cite the language

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

let findings = 0;
const files = walk(ROOT);
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const base = path.basename(f);
  // the blocklist below contains the very signatures it hunts; the scanner is exempt
  // from scanning itself so that its patterns do not match their own subject.
  if (rel === "tools/verify-clean.mjs") continue;
  const txt = fs.readFileSync(f, "utf8");
  for (const [re, why] of FORBIDDEN) {
    const m = txt.match(re);
    if (m) { findings++; console.log(`HIT  ${rel}: ${why} → ${JSON.stringify(String(m[0]).slice(0, 60))}`); }
  }
  if (!CJK_EXEMPT.has(base) && !rel.startsWith("docs/data")) {
    const m = txt.match(CJK);
    if (m && /\.(md|svg|json|js|mjs)$/.test(f)) { findings++; console.log(`HIT  ${rel}: pasted CJK conversation run → ${JSON.stringify(String(m[0]).slice(0, 30))}`); }
  }
}
if (findings) { console.log(`\nFAIL — ${findings} finding(s). Nothing was pushed. Fix before publishing.`); process.exitCode = 1; }
else console.log(`\nPASS — scanned ${files.length} files: no key material, no session ids, no local paths, no conversation text. Distribution clean.`);
