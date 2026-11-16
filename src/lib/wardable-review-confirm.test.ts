/**
 * Wardable review → confirm binding. Synthetic in-memory local table and
 * fake Hub only; no network, no real patients, nothing applied.
 */
import { describe, it, expect } from "vitest";
import { fakeHub } from "@/test-utils/fake-hub";
import { fakeWardableDb } from "@/test-utils/fake-wardable-db";
import {
  confirmReviewedWardable,
  reviewWardableRetry,
  runSetWardable,
  syncWardableToHub,
  signReviewToken,
  verifyReviewToken,
} from "./wardable-status.server";

const PT = "77777777-7777-4777-8777-777777777777";
const actor = { id: "88888888-8888-4888-8888-888888888888", role: "clinician" as const };
const caller = { userId: actor.id, actor };
const SECRET = "synthetic-review-secret";
const T0 = Date.parse("2026-11-16T12:00:00.000Z");

function setup(opts: { startCounters?: Record<string, bigint> } = {}) {
  const w = fakeWardableDb(opts);
  const hub = fakeHub([{ id: PT, wardable: false }]);
  let now = T0;
  const deps = (extra: Record<string, unknown> = {}) => ({ ...hub.deps, reviewSecret: SECRET, now: () => new Date(now), ...extra });
  const set = (wardable: boolean) => runSetWardable(w.db, w.db, { partner_patient_id: PT, wardable }, actor, hub.deps);
  const sync = () => syncWardableToHub(w.db, PT, actor, hub.deps);
  const review = (extra: Record<string, unknown> = {}, who = caller) => reviewWardableRetry(w.db, PT, who, deps(extra));
  const confirm = (token: unknown, extra: Record<string, unknown> = {}, who = caller, userDb = w.db) =>
    confirmReviewedWardable(userDb as never, w.db, token, who, deps(extra));
  const gets = () => hub.calls.filter((c) => c.method === "GET").length;
  const posts = () => hub.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/patients/wardable"));
  return { w, hub, set, sync, review, confirm, gets, posts, advance: (ms: number) => (now += ms) };
}

/** Hub applied rev N, then its value was changed natively in the Hub. */
async function appliedThenNativeChange(s: ReturnType<typeof setup>) {
  const r = await s.set(true);
  expect(r.ok && r.partner.status).toBe("synced");
  s.hub.externalEdit(PT, { wardable: false });
  expect(await s.sync()).toMatchObject({ status: "conflict", reason: "target_changed", recorded: true });
}

describe("review is bound to what was shown", () => {
  it("confirm sends the reviewed Hub updated_at unchanged and never re-reads the Hub", async () => {
    const s = setup();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    const rv = await s.review();
    const reviewedCas = s.hub.store.get(PT)!.updated_at;
    const getsBefore = s.gets();
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "synced", revision: "1", recorded: true });
    expect(s.gets()).toBe(getsBefore);
    expect(s.posts().at(-1)!.body).toEqual({ id: PT, expected_updated_at: reviewedCas, wardable: true, desired_revision: "1" });
  });

  it("Hub changed after review → conflict; no silent rebase, no second attempt", async () => {
    const s = setup();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    const rv = await s.review();
    s.hub.externalEdit(PT, { outstanding_tasks: "someone else" });
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "conflict", reason: "revision_conflict" });
    expect(s.posts()).toHaveLength(1);
    expect(s.hub.store.get(PT)!.wardable).toBe(false);
  });

  it("local state changed after review → refused before any Hub write", async () => {
    const s = setup();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    const rv = await s.review();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: false });
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "pending", reason: "changed_since_review" });
    expect(s.posts()).toHaveLength(0);
  });

  it("token is bound to the user, signature and expiry", async () => {
    const s = setup();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    const { token } = (await s.review()).confirm!;
    const other = { userId: "99999999-9999-4999-8999-999999999999", actor };
    expect(await s.confirm(token, {}, other)).toMatchObject({ status: "failed", reason: "review_invalid" });
    expect(await s.confirm(token, { reviewSecret: "other-secret" })).toMatchObject({ reason: "review_invalid" });
    const body = verifyReviewToken(token, SECRET)!;
    const forged = `${Buffer.from(JSON.stringify({ ...body, lw: false })).toString("base64url")}.${token.split(".")[1]}`;
    expect(await s.confirm(forged)).toMatchObject({ reason: "review_invalid" });
    expect(await s.confirm(`${token}.x`)).toMatchObject({ reason: "review_invalid" });
    s.advance(2 * 60_000 + 1);
    expect(await s.confirm(token)).toMatchObject({ status: "pending", reason: "review_expired" });
    expect(s.posts()).toHaveLength(0);
  });

  it("a confirm token is only issued after a successful Hub review", async () => {
    const s = setup();
    await s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    s.hub.control.down = true;
    expect(await s.review()).toMatchObject({ hub: { state: "unavailable" }, confirm: null });
    s.hub.control.down = false;
    s.hub.unshare(PT);
    expect(await s.review()).toMatchObject({ hub: { state: "not_shared" }, confirm: null });
    const t = setup();
    await t.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: true });
    expect(await t.review({ reviewSecret: "" })).toMatchObject({ hub: { state: "ok" }, confirm: null });
  });

  it("nothing to confirm when the Hub already shows the applied revision's value", async () => {
    const s = setup();
    await s.set(true);
    expect(await s.review()).toMatchObject({ local: { desired_revision: "1" }, hub: { state: "ok", wardable: true }, confirm: null });
  });
});

describe("applied intent followed by a native Hub change", () => {
  it("needs a NEW durable revision, conditional on the reviewed one, sent with the reviewed Hub CAS", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    expect(s.w.row(PT)).toMatchObject({ desired_revision: "1", partner_synced_revision: "1", partner_sync_status: "conflict" });
    const rv = await s.review();
    expect(rv.confirm).toMatchObject({ mode: "new_revision" });
    const reviewedCas = s.hub.store.get(PT)!.updated_at;
    const getsBefore = s.gets();
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "synced", revision: "2", recorded: true });
    expect(s.gets()).toBe(getsBefore);
    expect(s.posts().at(-1)!.body).toEqual({ id: PT, expected_updated_at: reviewedCas, wardable: true, desired_revision: "2" });
    expect(s.w.hooks.rpcCalls).toHaveLength(1);
    expect(s.w.hooks.rpcCalls[0].args).toEqual({ _partner_patient_id: PT, _reviewed_revision: "1", _wardable: true });
    expect(s.hub.store.get(PT)!.wardable).toBe(true);
    expect(s.w.row(PT)).toMatchObject({ desired_revision: "2", partner_synced_revision: "2", partner_sync_status: "synced" });
  });

  it("re-sending the old revision is never offered (it can only conflict again)", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    expect((await s.review()).confirm!.mode).toBe("new_revision");
    expect(await s.sync()).toMatchObject({ reason: "target_changed" });
  });

  it("local toggle racing the confirmation: the conditional allocation writes nothing and nothing is sent", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    const rv = await s.review();
    s.w.hooks.beforeConfirm = () => {
      // A newer toggle commits between the token check and the allocation.
      void s.w.db.rpc("set_wardable_desired_state", { _partner_patient_id: PT, _wardable: false });
    };
    const postsBefore = s.posts().length;
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "pending", reason: "changed_since_review" });
    expect(s.posts()).toHaveLength(postsBefore);
    expect(s.w.row(PT)).toMatchObject({ desired_revision: "2", wardable: false });
  });

  it("Hub changed after review → the new revision conflicts; next review re-sends that same revision", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    const rv = await s.review();
    s.hub.externalEdit(PT, { outstanding_tasks: "someone else" });
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "conflict", reason: "revision_conflict", revision: "2" });
    const again = await s.review();
    expect(again.confirm!.mode).toBe("resend");
    expect(await s.confirm(again.confirm!.token)).toMatchObject({ status: "synced", revision: "2" });
    expect(s.w.counters.get(PT)).toBe(2n); // no extra revision
  });

  it("unknown transport outcome: a repeated confirm never allocates twice; the next review re-sends the same intent", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    const rv = await s.review();
    s.hub.control.hang = true;
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "failed", reason: "unavailable", revision: "2" });
    s.hub.control.hang = false;
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "pending", reason: "changed_since_review" });
    expect(s.w.counters.get(PT)).toBe(2n);
    const again = await s.review();
    expect(again.confirm!.mode).toBe("resend");
    expect(await s.confirm(again.confirm!.token)).toMatchObject({ status: "synced", revision: "2" });
  });

  it("revisions above 2^53 stay exact decimal strings through review, allocation and the Hub body", async () => {
    const s = setup({ startCounters: { [PT]: 9007199254740992n } });
    await appliedThenNativeChange(s);
    const rv = await s.review();
    expect(rv.local!.desired_revision).toBe("9007199254740993");
    expect(verifyReviewToken(rv.confirm!.token, SECRET)!.lr).toBe("9007199254740993");
    expect(await s.confirm(rv.confirm!.token)).toMatchObject({ status: "synced", revision: "9007199254740994" });
    expect(s.posts().at(-1)!.body!.desired_revision).toBe("9007199254740994");
    expect(s.w.row(PT)!.partner_synced_revision).toBe("9007199254740994");
  });

  it("caller without clinical access, or before the staged procedure exists: nothing is sent", async () => {
    const s = setup();
    await appliedThenNativeChange(s);
    const rv = await s.review();
    const denied = fakeWardableDb({ clinical: false }).db;
    expect(await s.confirm(rv.confirm!.token, {}, caller, denied)).toMatchObject({ status: "failed", reason: "local_forbidden" });
    const missing = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "x" } }) };
    const postsBefore = s.posts().length;
    expect(await s.confirm(rv.confirm!.token, {}, caller, missing as never)).toMatchObject({ reason: "paused_until_release" });
    expect(s.posts()).toHaveLength(postsBefore);
  });
});

describe("review token format", () => {
  it("rejects revisions above the Postgres bigint maximum and non-canonical ids", () => {
    const base = { v: 1 as const, sub: actor.id, pt: PT, lr: "1", lw: true, hu: "x", hw: false, m: "resend" as const, exp: T0 };
    expect(verifyReviewToken(signReviewToken(base, SECRET), SECRET)).toEqual(base);
    expect(verifyReviewToken(signReviewToken({ ...base, lr: "9223372036854775808" }, SECRET), SECRET)).toBeNull();
    expect(verifyReviewToken(signReviewToken({ ...base, pt: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, SECRET), SECRET)).toBeNull();
    expect(verifyReviewToken(signReviewToken({ ...base, hu: "" }, SECRET), SECRET)).toBeNull();
  });
});
