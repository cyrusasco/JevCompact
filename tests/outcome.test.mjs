// Regression tests for the outcome-trim mode (「成果取代探索」, round-10).
// Run: npm test (node --test tests/payload.test.mjs tests/outcome.test.mjs)
// Fixtures are SYNTHETIC — marked fx_* / sess_fixture_*; no real session content.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { planOutcomeTrim, planSha256, verifyPlanSource } from "../lib/outcome-trim.mjs";
import { planOutcomeTrimForSession, applyOutcomePlan, restoreOutcomePlan, finalizeOutcomeLedger } from "../lib/zcode-jve.mjs";

/* ---------------- fixture DB builder (isolated copy, exact live schema subset) ---------------- */
const SCHEMA = [
  "CREATE TABLE session ( id text primary key, title text, parent_id text )",
  "CREATE TABLE message ( id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer )",
  "CREATE TABLE part ( id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer )",
];
let TMP;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-test-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const CONSOLE_TOOL = "mcp__node_repl__js";
function toolPart(id, messageId, session, ts, { input, output, display, status = "completed", tool = CONSOLE_TOOL }) {
  const st = { status, input };
  if (output !== undefined) st.output = output;
  if (display !== undefined) st.metadata = { display };
  return { id, message_id: messageId, session_id: session, time_created: ts, time_updated: ts, data: JSON.stringify({ type: "tool", tool, callID: "call_fx_" + id, state: st }), sequence: null };
}
function textPart(id, messageId, session, ts, text) {
  return { id, message_id: messageId, session_id: session, time_created: ts, time_updated: ts, data: JSON.stringify({ type: "text", text }), sequence: null };
}
function buildDb(file, { parts, messages }) {
  const db = new DatabaseSync(file, { open: true });
  for (const s of SCHEMA) db.exec(s);
  db.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run(MAIN, "fixture main");
  db.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run(OTHER, "fixture other");
  for (const m of messages) db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(m.id, m.session_id, m.ts, m.ts, JSON.stringify({ role: m.role }));
  for (const p of parts) db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.id, p.message_id, p.session_id, p.ts, p.ts, p.data, null);
  db.close();
}

const MAIN = "sess_fixture_main", OTHER = "sess_fixture_other";
// a standard task: exploration e1,e2 → method m-row → outcome o1; failure f1 (still-valid);
// empty result z1 (unproven); text t1 (I1); old-value comparison row c1 (CRITICAL "pass");
// an outside-scope console row x1; another session's row OTHER1.
function stdFixture(file) {
  const messages = [
    { id: "mfx1", session_id: MAIN, ts: 1000, role: "user" },
    { id: "mfx2", session_id: MAIN, ts: 2000, role: "assistant" },
    { id: "mfx3", session_id: OTHER, ts: 3000, role: "assistant" },
  ];
  const P = (id, mid, ses, ts, spec) => (spec.type === "text" ? textPart(id, mid, ses, ts, spec.text) : toolPart(id, mid, ses, ts, spec));
  const parts = [
    P("fx_e1", "mfx2", MAIN, 1010, { input: { title: "task", code: "read https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit" }, output: "partial load" }),
    P("fx_e2", "mfx2", MAIN, 1020, { input: { title: "task", code: "read https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit again" }, output: "retry" }),
    P("fx_m1", "mfx2", MAIN, 1030, { input: { code: "bootstrap https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit rows" }, output: "method ok, rows listed" }),
    P("fx_o1", "mfx2", MAIN, 1040, { input: { code: "final https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit values" }, output: "RESULT: 37 rows loaded" }),
    P("fx_f1", "mfx2", MAIN, 1050, { input: { code: "probe https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit" }, status: "error", output: "Error: permission denied on range Y" }),
    P("fx_z1", "mfx2", MAIN, 1060, { input: { code: "footer https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit" }, output: "" }),
    P("fx_c1", "mfx2", MAIN, 1070, { input: { code: "verify https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit" }, output: "test result: 37 pass 0 fail" }),
    P("fx_x1", "mfx2", MAIN, 1080, { input: { code: "unrelated task about cats" }, output: "meow data" }),
    P("fx_t1", "mfx1", MAIN, 1005, { type: "text", text: "用戶原文：請讀 Master order 並保留舊值 37 作比較" }),
    P("fx_OTHER1", "mfx3", OTHER, 3000, { input: { code: "other session row" }, output: "other" }),
  ];
  buildDb(file, { messages, parts: parts.map((p) => ({ ...p, ts: p.time_created })) });
  return parts;
}

/* ---------------- planner rules ---------------- */
test("outcome planner: successful result replaces exploration rows, with per-item replaced_by", () => {
  const rows = [
    { part_id: "e1", tool: CONSOLE_TOOL, bytes: 10, input_text: "read https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444", output_text: "partial", status: "completed" },
    { part_id: "e2", tool: CONSOLE_TOOL, bytes: 12, input_text: "read https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 again", output_text: "retry", status: "completed" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 20, input_text: "final https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 values", output_text: "RESULT: 37 rows", status: "completed" },
  ];
  const { plan, notes } = planOutcomeTrim({ rows, topics: ["docs.google.com/spreadsheets/d/aaaa1111"] });
  assert.equal(plan.counts.candidates, 1, "e1 = method record (first success), e2 = superseded exploration");
  assert.ok(plan.candidates.every((c) => c.replaced_by === "o1"));
  assert.equal(plan.outcome.method_part_id, "e1");
  assert.equal(plan.outcome.anchor_part_id, "o1");
  assert.ok(notes.join(" ").includes("heuristic"));
});

test("outcome planner: same bootstrap prefix but different task stays outside the scope", () => {
  const rows = [
    { part_id: "a1", tool: CONSOLE_TOOL, bytes: 5, input_text: "bootstrap https://docs.google.com/spreadsheets/d/aaaa1111bbbb2222cccc3333dddd4444 edit alpha", output_text: "alpha rows", status: "completed" },
    { part_id: "b1", tool: CONSOLE_TOOL, bytes: 5, input_text: "bootstrap cat pictures album", output_text: "cat rows", status: "completed" },
  ];
  const { plan } = planOutcomeTrim({ rows, topics: ["alpha"] });
  assert.equal(plan.counts.in_scope, 1);
  assert.equal(plan.counts.outside_scope, 1);
  assert.ok(!plan.candidates.some((c) => c.part_id === "b1"));
});

test("outcome planner: no successful row → nothing proposed (unfinished work)", () => {
  const rows = [
    { part_id: "e1", tool: CONSOLE_TOOL, bytes: 5, input_text: "try topic-x", output_text: "", status: "error" },
  ];
  const r = planOutcomeTrim({ rows, topics: ["topic-x"] });
  assert.equal(r.plan, null);
  assert.ok(r.notes.join(" ").includes("no_outcome_evidence"));
});

test("outcome planner: still-valid failure evidence is retained, not dropped", () => {
  const rows = [
    { part_id: "f1", tool: CONSOLE_TOOL, bytes: 5, input_text: "probe task-target-xyz", status: "error", output_text: "Error: permission denied" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 8, input_text: "task-target-xyz final", output_text: "RESULT loaded", status: "completed" },
  ];
  const { plan } = planOutcomeTrim({ rows, topics: ["task-target-xyz"] });
  assert.ok(plan.retained.some((r) => r.part_id === "f1" && r.reason === "failure_evidence"));
  assert.ok(!plan.candidates.some((c) => c.part_id === "f1"));
});

test("outcome planner: resolved failures are ALSO retained (conservative over-retention, documented)", () => {
  const rows = [
    { part_id: "f1", tool: CONSOLE_TOOL, bytes: 5, input_text: "probe task-target-xyz", status: "error", output_text: "Error: transient" },
    { part_id: "fix1", tool: CONSOLE_TOOL, bytes: 5, input_text: "task-target-xyz fixed the transient thing", output_text: "resolved, all ok", status: "completed" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 8, input_text: "task-target-xyz final", output_text: "RESULT loaded", status: "completed" },
  ];
  const { plan } = planOutcomeTrim({ rows, topics: ["task-target-xyz"] });
  // the resolved error row stays too — the engine cannot prove which failures stay relevant
  assert.ok(plan.retained.some((r) => r.part_id === "f1"), "resolved failure over-retained by design");
});

test("outcome planner: empty result is retained (empty_result_unproven)", () => {
  const rows = [
    { part_id: "z1", tool: CONSOLE_TOOL, bytes: 5, input_text: "footer task-target-xyz", output_text: "", status: "completed" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 8, input_text: "task-target-xyz final", output_text: "RESULT loaded", status: "completed" },
  ];
  const { plan } = planOutcomeTrim({ rows, topics: ["task-target-xyz"] });
  assert.ok(plan.retained.some((r) => r.part_id === "z1" && r.reason === "empty_result_unproven"));
});

test("outcome planner: old-value comparison rows (CRITICAL content) are retained", () => {
  const rows = [
    { part_id: "c1", tool: CONSOLE_TOOL, bytes: 5, input_text: "verify task-target-xyz", output_text: "test result: 37 pass 0 fail", status: "completed" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 8, input_text: "task-target-xyz final", output_text: "RESULT loaded", status: "completed" },
  ];
  const { plan } = planOutcomeTrim({ rows, topics: ["task-target-xyz"] });
  assert.ok(plan.retained.some((r) => r.part_id === "c1" && r.reason === "critical_evidence"));
});

test("plan hash: any post-stamp edit breaks verification", () => {
  const plan = { counts: { candidates: 1 }, candidates: [{ part_id: "a", bytes: 1, replaced_by: "b" }], outcome: { anchors: ["b"] }, retained: [], session_id: "s", plan_sha256: "" };
  const h = planSha256(plan);
  assert.equal(planSha256({ ...plan, plan_sha256: h }), h);
  const tampered = { ...plan, plan_sha256: h, candidates: [{ part_id: "a", bytes: 999, replaced_by: "b" }] };
  assert.notEqual(planSha256(tampered), h);
});

test("source-unchanged verification catches byte drift", () => {
  const plan = { candidates: [{ part_id: "e1", bytes: 10, replaced_by: "o1" }], retained: [], outcome: { anchors: ["o1"] } };
  const rowsNow = [{ part_id: "e1", bytes: 999 }, { part_id: "o1", bytes: 8 }];
  const v = verifyPlanSource(plan, rowsNow);
  assert.equal(v.ok, false);
  assert.ok(v.problems[0].problem === "bytes_changed");
});

/* ---------------- end-to-end on an isolated copy ---------------- */
test("apply → restore round-trip on an isolated copy: affected rows 100% identical, others untouched", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  const parts = stdFixture(dbFile);
  const before = {};
  const db0 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  for (const p of parts) before[p.id] = db0.prepare("SELECT data FROM part WHERE id = ?").get(p.id)?.data;
  const totalBefore = db0.prepare("SELECT COUNT(*) n FROM part").get().n;
  db0.close();

  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  assert.equal(planned.ok, true);
  const plan = planned.plan;
  assert.ok(plan.counts.candidates >= 2, "exploration rows are candidates");
  assert.ok(plan.candidates.every((c) => !["fx_f1", "fx_z1", "fx_c1", "fx_t1", "fx_OTHER1", "fx_o1", "fx_e1"].includes(c.part_id)), "protected rows must never be candidates");
  assert.ok(plan.retained.some((r) => r.part_id === "fx_e1" && r.reason === "method_record_first_success"), "first success = method record");
  assert.equal(plan.outcome.anchor_part_id, "fx_o1", "last plain success = outcome anchor");
  assert.equal(plan.plan_sha256, planSha256(plan));

  const backupDir = path.join(TMP, "backups");
  const applied = await applyOutcomePlan({ plan, apply: true, dbPath: dbFile, backupDir, log: () => {} });
  assert.equal(applied.ok, true, applied.error ?? "apply failed");
  assert.equal(applied.recovery_pending, false);

  // post-apply state: candidates gone; everything else present
  const db1 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  for (const c of plan.candidates) assert.equal(db1.prepare("SELECT COUNT(*) n FROM part WHERE id = ?").get(c.part_id).n, 0, "candidate row deleted");
  for (const keep of ["fx_o1", "fx_f1", "fx_z1", "fx_c1", "fx_t1", "fx_x1", "fx_OTHER1"]) assert.equal(db1.prepare("SELECT COUNT(*) n FROM part WHERE id = ?").get(keep).n, 1, keep + " untouched");
  assert.equal(db1.prepare("SELECT COUNT(*) n FROM part").get().n, totalBefore - plan.counts.candidates);
  db1.close();

  // restore: 100% identical content, other rows untouched
  const r = await restoreOutcomePlan({ ledgerFile: applied.ledger_file, dbPath: dbFile, log: () => {} });
  assert.equal(r.ok, true, JSON.stringify({ conflicts: r.conflicts, mismatches: r.mismatches }));
  assert.equal(r.verified, r.restored);
  const db2 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  for (const p of parts) assert.equal(db2.prepare("SELECT data FROM part WHERE id = ?").get(p.id)?.data, before[p.id], p.id + " byte-identical after round-trip");
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM part").get().n, totalBefore);
  db2.close();
});

test("apply refuses when the source rows changed after the plan was stamped", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  stdFixture(dbFile);
  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  // mutate one candidate row after stamping
  const db = new DatabaseSync(dbFile, { open: true });
  db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify({ type: "tool", tool: CONSOLE_TOOL, callID: "x", state: { status: "completed", input: {}, output: "mutated" } }), planned.plan.candidates[0].part_id);
  db.close();
  const applied = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir: path.join(TMP, "b2"), log: () => {} });
  assert.equal(applied.ok, false);
  assert.ok(applied.error.includes("changed since the plan was stamped"));
});

test("double apply is refused (rows already deleted → source check fails)", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  stdFixture(dbFile);
  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  const backupDir = path.join(TMP, "b3");
  const first = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir, log: () => {} });
  assert.equal(first.ok, true);
  const second = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir, log: () => {} });
  assert.equal(second.ok, false);
});

test("missing skill path aborts before any write; ledger-failure path reports recovery_pending honestly", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  stdFixture(dbFile);
  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  const missing = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir: path.join(TMP, "b4"), skillPath: path.join(TMP, "no-such-SKILL.md"), log: () => {} });
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes("skill path not found"));
  // ledger finalize recovery: simulate a crash between COMMIT and ledger write
  const applied = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir: path.join(TMP, "b5"), log: () => {} });
  assert.equal(applied.ok, true);
  const ledger = JSON.parse(fs.readFileSync(applied.ledger_file, "utf8"));
  ledger.status = "prepared"; // simulate the stale-prepared state
  fs.writeFileSync(applied.ledger_file, JSON.stringify(ledger, null, 1));
  const fin = await finalizeOutcomeLedger({ ledgerFile: applied.ledger_file, dbPath: dbFile, log: () => {} });
  assert.equal(fin.ok, true);
});

test("restore conflict: a deleted id re-created with different content is reported, never overwritten", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  stdFixture(dbFile);
  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  const applied = await applyOutcomePlan({ plan: planned.plan, apply: true, dbPath: dbFile, backupDir: path.join(TMP, "b6"), log: () => {} });
  assert.equal(applied.ok, true);
  // re-create the first deleted id with DIFFERENT content (as a new post-compression row)
  const db = new DatabaseSync(dbFile, { open: true });
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(planned.plan.candidates[0].part_id, "mfx2", MAIN, 9999, 9999, JSON.stringify({ type: "tool", tool: CONSOLE_TOOL, callID: "new", state: { status: "completed", input: {}, output: "new life for this id" } }));
  db.close();
  const r = await restoreOutcomePlan({ ledgerFile: applied.ledger_file, dbPath: dbFile, log: () => {} });
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.part_id === planned.plan.candidates[0].part_id && c.problem === "row_exists_with_different_content"));
  // the conflicting row's new content was NOT overwritten
  const db2 = new DatabaseSync(dbFile, { open: true, readOnly: true });
  assert.ok(db2.prepare("SELECT data FROM part WHERE id = ?").get(planned.plan.candidates[0].part_id).data.includes("new life"));
  db2.close();
});

test("I1: text parts are never candidates (planner sees tool rows only)", async () => {
  const dbFile = path.join(TMP, "fixture.sqlite");
  stdFixture(dbFile);
  const planned = await planOutcomeTrimForSession(MAIN, { topics: ["用戶原文", "Master order", "https://docs.google.com/spreadsheets/d/aaaa1111"], dbPath: dbFile });
  const ids = new Set([...planned.plan.candidates.map((c) => c.part_id), ...planned.plan.retained.map((r) => r.part_id)]);
  assert.ok(!ids.has("fx_t1"), "user text part must never enter the plan");
});

test("Tier-2 declaration (--archive-failures): failure/empty rows in scope become declared candidates", () => {
  const rows = [
    { part_id: "f1", tool: CONSOLE_TOOL, bytes: 5, input_text: "probe task-target-tier2", status: "error", output_text: "Error: permission denied" },
    { part_id: "z1", tool: CONSOLE_TOOL, bytes: 5, input_text: "footer task-target-tier2", output_text: "", status: "completed" },
    { part_id: "o1", tool: CONSOLE_TOOL, bytes: 8, input_text: "task-target-tier2 final", output_text: "RESULT loaded", status: "completed" },
  ];
  const conservative = planOutcomeTrim({ rows, topics: ["task-target-tier2"] });
  assert.ok(conservative.plan.retained.some((r) => r.part_id === "f1"), "default keeps failure evidence");
  const tier2 = planOutcomeTrim({ rows, topics: ["task-target-tier2"], opts: { archiveFailures: true } });
  assert.equal(tier2.plan.tier2.archive_failures, true);
  assert.ok(tier2.plan.candidates.some((c) => c.part_id === "f1" && c.archived_evidence === true), "declared failure row becomes a candidate");
  assert.ok(tier2.plan.candidates.some((c) => c.part_id === "z1"), "declared empty row becomes a candidate");
  assert.ok(!tier2.plan.retained.some((r) => r.part_id === "f1"), "no longer retained under the declaration");
  assert.equal(tier2.plan.outcome.anchor_part_id, "o1", "outcome anchor still kept");
});

test("allowDerived: a child session is refused by default and plannable with the explicit override", async () => {
  const dbFile = path.join(TMP, "child.sqlite");
  const db = new DatabaseSync(dbFile, { open: true });
  for (const s of SCHEMA) db.exec(s);
  db.prepare("INSERT INTO session (id, title, parent_id) VALUES (?, ?, ?)").run("sess_fixture_child", "child", "sess_fixture_parent");
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run("cfx_m1", "sess_fixture_child", 1, 1, JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, NULL)").run("cfx_p1", "cfx_m1", "sess_fixture_child", 1, 1, JSON.stringify({ type: "tool", tool: CONSOLE_TOOL, callID: "call_cfx_1", state: { status: "completed", input: { code: "task-target-final" }, output: "RESULT done" } }));
  db.close();
  const refused = await planOutcomeTrimForSession("sess_fixture_child", { topics: ["task-target"], dbPath: dbFile });
  assert.equal(refused.ok, false);
  assert.ok(refused.error.includes("derived"));
  const allowed = await planOutcomeTrimForSession("sess_fixture_child", { topics: ["task-target"], allowDerived: true, dbPath: dbFile });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.plan.outcome.anchor_part_id, "cfx_p1");
});
