import { expect, test, vi } from "vitest";
import { ContactCore } from "../src/core/contact";
import type { StreamCall } from "../src/core/types";
import { FakeClock, FakeWa, drain, makeEvalDeps, stubLlm } from "./harness";

const FROM = "15550000002";

function contact(reply?: (c: StreamCall) => string | Promise<string>) {
  const clock = new FakeClock();
  const view = clock.forContact(FROM);
  const wa = new FakeWa(clock);
  const llm = stubLlm({ reply });
  const deps = makeEvalDeps({ clock: view, wa, llm });
  const core = new ContactCore(deps);
  let n = 0;
  // Like the scenario runner: fire whatever is due before the step, then move the clock to it.
  const say = async (at: number, text: string) => {
    await drain(core, view, clock, at);
    clock.t = Math.max(clock.t, at);
    await core.ingest({ id: `wamid.${++n}`, from: FROM, ts: clock.t, kind: "text", text });
  };
  return { clock, view, wa, llm, core, db: deps.db, say, drain: (until: number) => drain(core, view, clock, until) };
}

test("a burst of three messages 1 s apart gets one reply", async () => {
  const c = contact();
  const t0 = c.clock.t;
  await c.say(t0, "I went to the market");
  await c.say(t0 + 1000, "bought apples");
  await c.say(t0 + 2000, "and pears");
  await c.drain(t0 + 60_000);
  expect(c.wa.sent.filter((s) => s.kind === "text")).toHaveLength(1);
  expect(c.db.all("SELECT id FROM turns")).toHaveLength(1);
});

test('"so basically..." waits 8 s', async () => {
  const c = contact();
  await c.say(c.clock.t, "so basically...");
  expect(c.view.alarmAt! - c.clock.t).toBe(8000);
});

test("a message arriving mid-generation gets one reply covering all messages", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = contact(async () => { if (c.llm.calls.length === 1) await gate; return "react: none\nok"; });
  const t0 = c.clock.t;
  await c.say(t0, "is the cafe open");
  const turn = c.drain(t0 + 60_000);
  await vi.waitFor(() => expect(c.llm.calls).toHaveLength(1));
  await c.core.ingest({ id: "wamid.late", from: FROM, ts: c.clock.t, kind: "text", text: "on sunday" });
  release();
  await turn;
  await c.drain(c.clock.t + 60_000);
  expect(c.wa.sent.filter((s) => s.kind === "text")).toHaveLength(1);
  const prompt = JSON.stringify(c.llm.calls.at(-1)!.messages);
  expect(prompt).toContain("is the cafe open");
  expect(prompt).toContain("on sunday");
});
