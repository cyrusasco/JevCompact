// Independent acceptance tests. Synthetic fixtures only; no product changes or model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { planOutcomeTrim } from '../lib/outcome-trim.mjs';
import { planOutcomeTrimForSession, applyOutcomePlan, restoreOutcomePlan, finalizeOutcomeLedger } from '../lib/zcode-jve.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-')); // repo run: fixtures are temporary, evidence dir keeps the originals
const FIXTURES = path.join(ROOT, 'fixtures');
fs.mkdirSync(FIXTURES, { recursive: true });
const SID = 'sess_codex_disposable_outcome_test';
const toolRow = (part_id, output_text, extra = {}) => ({ part_id, tool: 'node_repl', bytes: 10, input_text: 'scopealpha', output_text, status: 'completed', ...extra });
const basic = () => [toolRow('first', 'opened'), toolRow('middle', 'value 37'), toolRow('last', 'loaded')];

function fixture({ middleOutput = 'old value', middleDisplay, nullSequence = false } = {}) {
  const dir = fs.mkdtempSync(path.join(FIXTURES, 'case-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,sequence INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,sequence INTEGER);`);
  db.prepare('INSERT INTO session VALUES(?,?,NULL)').run(SID, 'synthetic test');
  db.prepare('INSERT INTO session VALUES(?,?,NULL)').run('sess_codex_sentinel', 'other synthetic session');
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?)').run('m', SID, 1, 1, JSON.stringify({ role: 'assistant' }), 1);
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?)').run('u', SID, 0, 0, JSON.stringify({ role: 'user' }), 0);
  const insert = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?,?)');
  for (const [index, id, output] of [[1, 'first', 'opened'], [2, 'middle', middleOutput], [3, 'last', 'loaded']]) {
    const state = { status: 'completed', input: { code: 'scopealpha ' + id }, output };
    if (id === 'middle' && middleDisplay !== undefined) state.metadata = { display: middleDisplay };
    insert.run(id, 'm', SID, index, index, JSON.stringify({ type: 'tool', tool: 'node_repl', callID: 'call_fixture_' + id, state }), nullSequence ? null : index);
  }
  insert.run('user_text', 'u', SID, 0, 0, JSON.stringify({ type: 'text', text: '用戶原文：需要保留舊值作比較' }), 0);
  insert.run('sentinel', 'other', 'sess_codex_sentinel', 9, 9, JSON.stringify({ type: 'text', text: 'SENTINEL' }), 9);
  db.close();
  return { dir, dbPath, backupDir: path.join(dir, 'backups') };
}
function readAll(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT id,message_id,session_id,time_created,time_updated,data,sequence FROM part ORDER BY id').all().map(r => ({ ...r })); }
  finally { db.close(); }
}
function ordered(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT id FROM part WHERE message_id=? ORDER BY (sequence IS NULL),sequence,rowid').all('m').map(r => r.id); }
  finally { db.close(); }
}
function plan(f) {
  const result = planOutcomeTrimForSession(SID, { topics: ['scopealpha'], dbPath: f.dbPath });
  assert.equal(result.ok, true, result.error);
  return result.plan;
}
async function apply(f, p) { return applyOutcomePlan({ plan: p, apply: true, dbPath: f.dbPath, backupDir: f.backupDir }); }
function edit(dbPath, body) { const db = new DatabaseSync(dbPath); try { body(db); } finally { db.close(); } }

test('P01 positive: default keeps explicit failures and empty results', () => {
  const { plan: p } = planOutcomeTrim({ rows: [toolRow('fail', 'Error: denied', { status: 'error' }), toolRow('empty', ''), ...basic()], topics: ['scopealpha'] });
  assert.ok(p.retained.some(r => r.part_id === 'fail'));
  assert.ok(p.retained.some(r => r.part_id === 'empty'));
  assert.ok(!p.candidates.some(r => ['fail', 'empty'].includes(r.part_id)));
});

test('P02 positive: apply/restore preserves full row fields, user text and unrelated sentinel with explicit sequence', async () => {
  const f = fixture(); const before = readAll(f.dbPath); const p = plan(f);
  const a = await apply(f, p); assert.equal(a.ok, true, a.error);
  const after = readAll(f.dbPath);
  assert.ok(!after.some(r => r.id === 'middle'));
  for (const id of ['user_text', 'sentinel']) assert.deepEqual(after.find(r => r.id === id), before.find(r => r.id === id));
  const r = restoreOutcomePlan({ ledgerFile: a.ledger_file, dbPath: f.dbPath });
  assert.equal(r.ok, true); assert.deepEqual(readAll(f.dbPath), before);
});

test('P03 positive: edited plan with stale hash is refused before deletion', async () => {
  const f = fixture(); const before = readAll(f.dbPath); const p = plan(f); p.topics.push('tampered');
  const a = await apply(f, p); assert.equal(a.ok, false); assert.match(a.error, /hash mismatch/);
  assert.deepEqual(readAll(f.dbPath), before);
});

test('P04 positive: applying the same deletion plan twice is refused', async () => {
  const f = fixture(); const p = plan(f); assert.equal((await apply(f, p)).ok, true);
  const a = await apply(f, p); assert.equal(a.ok, false); assert.match(a.error, /changed since/);
});

test('F01 contract: a running/pending row must not become a completed outcome anchor', () => {
  const rows = [...basic(), toolRow('pending', 'waiting for user approval', { status: 'running' })];
  const { plan: p } = planOutcomeTrim({ rows, topics: ['scopealpha'] });
  assert.notEqual(p?.outcome.anchor_part_id, 'pending', 'running row was accepted as the completed outcome');
});

test('F02 contract: same URL does not establish replacement of a different task result', () => {
  const url = 'https://example.invalid/sheets/shared';
  const rows = [toolRow('first', 'opened', { input_text: `taskalpha ${url}` }), toolRow('unique', 'old value 37 needed for comparison', { input_text: `taskbeta ${url}` }), toolRow('last', 'taskalpha loaded', { input_text: `taskalpha ${url}` })];
  const { plan: p } = planOutcomeTrim({ rows, topics: ['taskalpha'] });
  assert.ok(!p.candidates.some(r => r.part_id === 'unique'), 'unique result of taskbeta is deleted under taskalpha');
});

test('F03 contract: protected failure must never also appear in deletion candidates', () => {
  const rows = [toolRow('first', 'opened'), toolRow('pinned', 'Error: permission denied', { status: 'error' }), toolRow('last', 'loaded')];
  const { plan: p } = planOutcomeTrim({ rows, topics: ['scopealpha'], opts: { archiveFailures: true, protectedPartIds: new Set(['pinned']) } });
  assert.ok(!p.candidates.some(r => r.part_id === 'pinned'), JSON.stringify({ retained: p.retained.map(r => r.part_id), deleted: p.candidates.map(r => r.part_id) }));
});

test('F04 contract: candidate IDs and deletion counts must be unique and consistent', () => {
  const rows = [toolRow('first', 'opened'), toolRow('fail', 'Error: permission denied', { status: 'error' }), toolRow('last', 'loaded')];
  const { plan: p } = planOutcomeTrim({ rows, topics: ['scopealpha'], opts: { archiveFailures: true } });
  assert.equal(p.candidates.length, new Set(p.candidates.map(r => r.part_id)).size, 'same failed row appears twice');
  assert.equal(p.counts.candidates, p.candidates.length);
});

test('F05 contract: actual DB planner retains failure evidence carried only in display', () => {
  const f = fixture({ middleOutput: 'OK', middleDisplay: 'Error: permission denied; pending approval' });
  const p = plan(f);
  assert.ok(!p.candidates.some(r => r.part_id === 'middle'), 'output OK hides critical display evidence');
});

test('F06 contract: same-byte-length source mutation must refuse actual apply', async () => {
  const f = fixture({ middleOutput: 'value AAA' }); const p = plan(f);
  edit(f.dbPath, db => {
    const old = db.prepare('SELECT data FROM part WHERE id=?').get('middle').data;
    const changed = old.replace('value AAA', 'value BBB');
    assert.equal(Buffer.byteLength(old), Buffer.byteLength(changed)); assert.notEqual(old, changed);
    db.prepare('UPDATE part SET data=? WHERE id=?').run(changed, 'middle');
  });
  const a = await apply(f, p);
  assert.equal(a.ok, false, JSON.stringify({ apply_ok: a.ok, changed_row_survives: readAll(f.dbPath).some(r => r.id === 'middle') }));
});

test('F07 contract: modified retained digest must block recovery finalization', async () => {
  const f = fixture(); const a = await apply(f, plan(f)); assert.equal(a.ok, true);
  const ledger = JSON.parse(fs.readFileSync(a.ledger_file, 'utf8')); ledger.status = 'prepared';
  fs.writeFileSync(a.ledger_file, JSON.stringify(ledger));
  edit(f.dbPath, db => db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({ changed: true }), 'last'));
  const r = finalizeOutcomeLedger({ ledgerFile: a.ledger_file, dbPath: f.dbPath });
  assert.equal(r.ok, false, JSON.stringify({ recovery: r, ledger_status: JSON.parse(fs.readFileSync(a.ledger_file, 'utf8')).status }));
});

test('F08 contract: restore must preserve transcript order when sequence is NULL', async () => {
  const f = fixture({ nullSequence: true }); const before = ordered(f.dbPath);
  const a = await apply(f, plan(f)); assert.equal(a.ok, true);
  const r = restoreOutcomePlan({ ledgerFile: a.ledger_file, dbPath: f.dbPath }); assert.equal(r.ok, true);
  assert.deepEqual(ordered(f.dbPath), before, 'row fields restore but rowid-based transcript order changes');
});

test('F09 contract: ledger finalize write failure must not return an unqualified successful apply', async () => {
  const f = fixture(); const p = plan(f); const original = fs.writeFileSync; let ledgerWrites = 0; let a;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(f.backupDir) && String(file).endsWith('.outcome-ledger.json') && ++ledgerWrites === 2) throw new Error('synthetic ledger finalization failure');
    return original.call(this, file, ...args);
  };
  try { a = await apply(f, p); } finally { fs.writeFileSync = original; }
  assert.equal(a.recovery_pending, true, 'failure injection must reach ledger finalization');
  assert.equal(a.ok, false, 'CLI uses ok to exit zero even while recovery_pending is true');
});
