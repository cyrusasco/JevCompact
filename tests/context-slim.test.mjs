// tests/context-slim.test.mjs (round-22) — B+ planner + apply/restore round-trip on an
// isolated synthetic copy. Fixtures marked cs_*; no real session content.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { planContextSlim, contextSlimSha, PLATFORM_NOISE_RE } from "../lib/context-slim.mjs";
import { readContextSlimRows, applyContextSlim } from "../lib/apply-context-slim.mjs";

let TMP;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cs-test-")); });
afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const SCHEMA = [
  "CREATE TABLE session ( id text primary key, title text, parent_id text )",
  "CREATE TABLE message ( id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer )",
  "CREATE TABLE part ( id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer )",
];
const SID = "sess_cs_fixture";
const mkText = (pid, mid, mi, role, text) => ({ part_id: pid, message_id: mid, msg_index: mi, role, type: "text", text, data: JSON.stringify({ type: "text", text }) });
const mkTool = (pid, mid, mi, tool, input, output, status = "completed") => ({ part_id: pid, message_id: mid, msg_index: mi, role: "assistant", type: "tool", tool, input: JSON.stringify(input), output, display: "", status, data: JSON.stringify({ type: "tool", tool, callID: "call_cs_" + pid, state: { status, input, output } }) });

function rowsFixture() {
  const rows = [];
  rows.push(mkText("cs_u_real", "m1", 0, "user", "唔好用 method A，改用 method B 處理 order-sync.html"));
  rows.push(mkText("cs_u_noise1", "m1", 0, "user", "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit…"));
  rows.push(mkText("cs_u_noise2", "m1", 0, "user", "<task-notification> <task-id>exec_x</task-id> … </task-notification>"));
  rows.push(mkText("cs_a_recent", "m2", 1, "assistant", "最新結論：method B 已上線"));
  rows.push(mkText("cs_a_old", "m1", 0, "assistant", "舊結論（第3輪）……"));
  rows.push(mkTool("cs_t_carrier", "m1", 0, "Bash", { command: "run method-b" }, "method-b output: 唔好用 method A 改用 method B 處理 order-sync.html — fixed " + "x".repeat(400)));
  rows.push(mkTool("cs_t_i3", "m1", 0, "Bash", { command: "npm test" }, "test result: 37 pass 0 fail " + "y".repeat(400)));
  rows.push(mkTool("cs_t_todo1", "m1", 0, "TodoWrite", { todos: [] }, '{"oldTodos":[1]}'));
  rows.push(mkTool("cs_t_todo2", "m2", 1, "TodoWrite", { todos: [] }, '{"oldTodos":[2]}'));
  rows.push(mkTool("cs_t_old_explore", "m1", 0, "Bash", { command: "try A" }, "A failed"));
  rows.push(mkTool("cs_t_recent", "m3", 2, "Bash", { command: "current" }, "current output"));
  return rows;
}

test("B+ planner: user words kept, platform noise → notes, TodoWrite dedup, carrier/i3 slimmed, old exploration noted", () => {
  const rows = rowsFixture();
  const plan = planContextSlim(rows, {
    correctionEntities: new Set(["唔好用 method A 改用 method B 處理 order-sync.html — fixed"]),
    i3CallIds: new Set(["cs_t_i3"]),
    pendingCallIds: new Set([]),
  });
  const byAction = new Map(plan.edits.map((e) => [e.part_id, e]));
  assert.equal(byAction.get("cs_u_real").action, "keep");
  assert.equal(byAction.get("cs_u_real").why, "real-user-word");
  assert.equal(byAction.get("cs_u_noise1").action, "noise-note");
  assert.equal(byAction.get("cs_u_noise2").action, "noise-note");
  assert.equal(byAction.get("cs_t_carrier").action, "slim");
  assert.equal(byAction.get("cs_t_i3").action, "slim");
  assert.equal(byAction.get("cs_t_todo1").action, "noise-note"); // older todo snapshot
  assert.equal(byAction.get("cs_t_todo2").action, "keep"); // latest todo
  assert.equal(byAction.get("cs_t_old_explore").action, "noise-note");
  assert.ok(plan.est.after_tokens < plan.est.before_tokens, `after ${plan.est.after_tokens} < before ${plan.est.before_tokens}`);
  assert.equal(plan.counts.keep_user_words, 1);
});

test("PLATFORM_NOISE_RE classifies the real platform-noise prefixes and not real words", () => {
  assert.ok(PLATFORM_NOISE_RE.test("The TodoWrite tool hasn't been used recently…"));
  assert.ok(PLATFORM_NOISE_RE.test("<task-notification> <task-id>x"));
  assert.ok(PLATFORM_NOISE_RE.test("<plugin_reference> The user referenced"));
  assert.ok(PLATFORM_NOISE_RE.test("This session is being continued from a previous conversation"));
  assert.ok(!PLATFORM_NOISE_RE.test("唔好用 method A"));
  assert.ok(!PLATFORM_NOISE_RE.test("again 我地只係block 圖"));
});

test("apply → restore round-trip on an isolated copy: real user word byte-identical, noise rows noted, restore 100%", async () => {
  const dbFile = path.join(TMP, "cs.sqlite");
  const db = new DatabaseSync(dbFile, { open: true });
  for (const s of SCHEMA) db.exec(s);
  db.prepare("INSERT INTO session (id,title) VALUES (?,?)").run(SID, "cs");
  const msgTs = { m1: 100, m2: 200, m3: 900 };
  for (const [mid, ts] of Object.entries(msgTs)) db.prepare("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)").run(mid, SID, ts, ts, JSON.stringify({ role: mid === "m1" ? "user" : "assistant" }));
  const rows = rowsFixture();
  const msgOf = { cs_u_real: "m1", cs_u_noise1: "m1", cs_u_noise2: "m1", cs_a_recent: "m2", cs_a_old: "m1", cs_t_carrier: "m1", cs_t_i3: "m1", cs_t_todo1: "m1", cs_t_todo2: "m2", cs_t_old_explore: "m1", cs_t_recent: "m3" };
  const tsOf = { m1: 100, m2: 200, m3: 900 };
  let k = 0;
  for (const r of rows) { const mid = msgOf[r.part_id]; db.prepare("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)").run(r.part_id, mid, SID, tsOf[mid] + k, tsOf[mid] + k, r.data); k++; }
  db.close();
  const rdb = new DatabaseSync(dbFile, { open: true, readOnly: true });
  const rowsNow = readContextSlimRows(rdb, SID);
  rdb.close();
  // re-key msg_index by re-reading: readContextSlimRows handles ordering
  const plan = planContextSlim(rowsNow, { correctionEntities: new Set(["唔好用 method A 改用 method B 處理 order-sync.html — fixed"]), i3CallIds: new Set(["cs_t_i3"]), pendingCallIds: new Set([]) });
  plan.session_id = SID;
  plan.plan_sha256 = contextSlimSha(plan);
  const bakDir = path.join(TMP, "bak");
  const res = await applyContextSlim({ plan, dbPath: dbFile, backupDir: bakDir, log: () => {} });
  assert.equal(res.ok, true, res.error ?? "apply failed");
  // verify: real user word unchanged; noise replaced; slim rows truncated
  const db2 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  const get = (id) => db2.prepare("SELECT data FROM part WHERE id=?").get(id)?.data;
  const realAfter = JSON.parse(get("cs_u_real"));
  assert.equal(realAfter.text, "唔好用 method A，改用 method B 處理 order-sync.html", "user word byte-identical");
  const noiseAfter = JSON.parse(get("cs_u_noise1"));
  assert.ok(noiseAfter.text.startsWith("[todo-reminder cleared"), "noise noted");
  const slimAfter = JSON.parse(get("cs_t_i3"));
  assert.ok(slimAfter.state.output.startsWith("test result: 37 pass 0 fail"), "i3 head kept");
  assert.ok(slimAfter.state.output.includes("chars slimmed by context-slim"), "slim marker present");
  // restore from the ledger
  const ledger = JSON.parse(fs.readFileSync(res.ledger_file, "utf8"));
  const bdb = new DatabaseSync(ledger.backup.file, { open: true, readOnly: true });
  const getB = bdb.prepare("SELECT data FROM part WHERE id=?");
  const upd = db2.prepare ? null : null;
  db2.close();
  const wdb = new DatabaseSync(dbFile, { open: true });
  wdb.exec("BEGIN IMMEDIATE");
  const updStmt = wdb.prepare("UPDATE part SET data = ? WHERE id = ?");
  let restored = 0;
  for (const [pid, rr] of Object.entries(ledger.restore_rows)) { if (rr) { updStmt.run(rr.data, pid); restored++; } }
  wdb.exec("COMMIT"); wdb.exec("PRAGMA wal_checkpoint"); wdb.close();
  const db3 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  for (const r of rows) assert.equal(db3.prepare("SELECT data FROM part WHERE id=?").get(r.part_id)?.data, r.data, r.part_id + " restored byte-identical");
  db3.close(); bdb.close();
});
