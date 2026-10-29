// Questionnaire logic: follow-on questions, optional modules, scoring and follow-up threads.
// Run with: node --test tests/intake-questions.test.js
import assert from "node:assert/strict";
import test from "node:test";
import * as m from "../intake-questions.js";
const { INTAKE_QUESTIONS, activeQuestions, summarizeIntake, deriveControlAnswers, validateIntake, mergeFollowups, awaitingVendor, followupRounds, cleanFollowups } = m;

test("ids are unique and match the AI schema pattern", () => {
  const ids = INTAKE_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Z]{2,3}[0-9]{1,2}$/);
  for (const q of INTAKE_QUESTIONS.filter((q) => q.parent)) {
    const parent = INTAKE_QUESTIONS.find((p) => p.id === q.parent);
    assert.ok(parent, `${q.id} parent exists`);
    assert.ok(INTAKE_QUESTIONS.indexOf(parent) < INTAKE_QUESTIONS.indexOf(q), `${q.id} comes after its parent`);
  }
});

test("follow-on questions appear only for the triggering answer", () => {
  const base = activeQuestions({}, []).map((q) => q.id);
  assert.ok(base.includes("SUB0") && !base.includes("SUB1") && !base.includes("CIP1"));
  const yes = activeQuestions({ SUB0: { answer: "Yes" } }, []).map((q) => q.id);
  assert.ok(["SUB1", "SUB2", "SUB3", "SUB5", "SUB6"].every((id) => yes.includes(id)));
  const no = activeQuestions({ SUB0: { answer: "No" } }, []).map((q) => q.id);
  assert.ok(!no.includes("SUB1"));
});

test("CIP-013 section only when the module is on", () => {
  const on = activeQuestions({ CIP4: { answer: "Yes" } }, ["cip013"]).map((q) => q.id);
  assert.ok(on.includes("CIP1") && on.includes("CIP5"));
  assert.ok(!activeQuestions({ CIP4: { answer: "Yes" } }, []).some((q) => q.module));
});

test("scoring ignores questions that don't apply", () => {
  const r = { answers: { SUB0: { answer: "No" }, SUB1: { answer: "No" }, GOV1: { answer: "Yes" } }, modules: [] };
  const s = summarizeIntake(r);
  assert.equal(s.score, 100);
  assert.ok(!s.flags.some((f) => f.id === "SUB1"));
  assert.equal(deriveControlAnswers(r).subproc, undefined);
});

test("v1 responses still validate", () => {
  const d = validateIntake({ format: "riskpilot-intake", version: 1, answers: {}, profile: {} });
  assert.deepEqual(d.modules, []);
  assert.deepEqual(d.followups, {});
  assert.throws(() => validateIntake({ format: "riskpilot-intake", version: 9, answers: {}, profile: {} }));
});

test("follow-ups are cleaned of bad data", () => {
  const f = cleanFollowups({ NOPE1: { messages: [{ by: "vendor", text: "x" }] }, GOV1: { status: "weird", messages: [{ by: "hacker", text: "x" }, { by: "vendor", text: "  ok  ", name: 5 }] } });
  assert.deepEqual(Object.keys(f), ["GOV1"]);
  assert.equal(f.GOV1.status, "open");
  assert.deepEqual(f.GOV1.messages.map((x) => [x.by, x.text, x.name]), [["vendor", "ok", "5"]]);
});

test("merging threads keeps one copy of each message, our status, and notes changed answers", () => {
  const ask = { by: "requester", name: "Us", text: "Timelines?", at: "1" };
  const ours = { VUL5: { status: "open", messages: [ask] }, GOV1: { status: "resolved", messages: [ask] } };
  const theirs = { VUL5: { status: "open", messages: [ask, { by: "vendor", name: "V", text: "72 hours via email", at: "2" }] }, GOV1: { status: "open", messages: [ask] } };
  const out = mergeFollowups(ours, theirs, { VUL5: { answer: "No" } }, { VUL5: { answer: "Yes" } }, "3");
  assert.equal(out.VUL5.messages.length, 3);
  assert.equal(out.VUL5.messages.at(-1).text, "Answer changed from No to Yes");
  assert.equal(out.GOV1.status, "resolved");
  assert.equal(followupRounds(out.VUL5), 1);
  assert.deepEqual(awaitingVendor(ours), ["VUL5"]);
  assert.deepEqual(awaitingVendor(out), []);
  assert.equal(ours.VUL5.messages.length, 1, "input not mutated");
});

test("a changed-answer note doesn't count as the vendor's turn", () => {
  const t = { status: "open", messages: [{ by: "requester", text: "q" }, { by: "vendor", text: "a" }, { by: "system", text: "Answer changed from No to Yes" }] };
  assert.equal(m.lastSpeaker(t), "vendor");
  assert.deepEqual(awaitingVendor({ VUL5: t }), []);
});
