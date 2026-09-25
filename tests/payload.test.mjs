// Regression tests for lib/zcode-jve.mjs — the judgement-payload fold (P0 round-4/6 fix).
// Zero-dependency: node:test (built into Node 22+). Run: npm test
// These cover the fix that the fast-jev-compaction bench tests exercise on the dev copy;
// this repo ships them so the published lib has its own regression net.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript } from "../lib/zcode-jve.mjs";

const CAP_MARK = " […judgement payload capped at 4096 chars…]";

function row(state) {
  const mrows = [{ id: "m1", data: JSON.stringify({ role: "assistant" }) }];
  const prow = { id: "p1", message_id: "m1", data: JSON.stringify({ type: "tool", tool: "node_repl", callID: "call_00_AaBbCc1", state }) };
  return buildTranscript(mrows, { all: () => [prow] })[0].toolResults[0].text;
}

test("folds output and display when both are present and display is not contained in output", () => {
  assert.equal(row({ status: "completed", output: "OUT", metadata: { display: "DISP" } }), "OUT\n[display] DISP");
});
test("does not duplicate a display already contained in the output", () => {
  assert.equal(row({ status: "completed", output: "A DISP B", metadata: { display: "DISP" } }), "A DISP B");
});
test("falls back to display when output is an empty string (the P0 blind case)", () => {
  assert.equal(row({ status: "completed", output: "", metadata: { display: "DISP-ONLY" } }), "DISP-ONLY");
});
test("falls back to display when output is absent", () => {
  assert.equal(row({ status: "completed", metadata: { display: "DISP-ONLY" } }), "DISP-ONLY");
});
test("caps an oversized payload at 4096 plus the marker", () => {
  const t = row({ status: "completed", metadata: { display: "x".repeat(5000) } });
  assert.equal(t.length, 4096 + CAP_MARK.length);
  assert.ok(t.startsWith("x".repeat(4096)));
});
test("kept transcript rows never contain rewritten text (no-rewrite contract smoke)", () => {
  const text = "用戶原文：批准套用及重開，376/376 PASS";
  const mrows = [{ id: "m2", data: JSON.stringify({ role: "user" }) }];
  const prow = { id: "p2", message_id: "m2", data: JSON.stringify({ type: "text", text }) };
  assert.equal(buildTranscript(mrows, { all: () => [prow] })[0].text, text);
});
