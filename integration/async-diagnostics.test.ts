import assert from "node:assert/strict";
import { test } from "vitest";
import { assistant, fixture } from "./async-compaction-fixture.js";

async function ready(logCompaction = true) {
  const h = fixture({ asyncAutoApply: true, logCompaction });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.ctx.isIdle = () => false;
  return h;
}

for (const logging of [true, false])
  test(`binding failure pause is visible with logging=${logging}`, async () => {
    const h = await ready(logging);
    h.setKey("SECRET-CHANGED-CREDENTIAL");
    assert.equal(await h.start(), undefined);
    const messages = h.notifications.map(({ message }) => message).join("\n");
    assert.equal(messages.includes("request authentication changed"), true);
    assert.doesNotMatch(messages, /SECRET-CHANGED-CREDENTIAL|fixture-key|example\.test/);
    assert.equal(h.fetches, 1);
  });

test("budget rejection includes only safe numeric components and pauses further preparation", async () => {
  const h = await ready();
  h.manager.appendMessage({ role: "user", content: "PRIVATE-TAIL ".repeat(50_000), timestamp: 3 });
  assert.equal(await h.start(), undefined);
  const message = h.notifications.find(({ message }) => message.includes("token budget exceeded"))?.message;
  assert.ok(message);
  assert.match(message, /estimated=\d+, replacement=\d+, suffix=\d+, prompt\/tools=\d+, context=100000, reserve=1000/);
  assert.doesNotMatch(message, /PRIVATE-TAIL/);
  assert.equal(h.fetches, 1);
  await h.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.fetches, 1);
});

for (const change of ["prompt", "unpaired", "projection", "auth-lookup", "navigation"])
  test(`discard reports ${change} without disclosing values`, async () => {
    const h = await ready();
    let reason: RegExp;
    if (change === "prompt") {
      h.setPrompt("PRIVATE-SYSTEM-PROMPT");
      reason = /system prompt changed/;
    } else if (change === "unpaired") {
      h.manager.appendMessage({
        ...assistant(""),
        content: [{ type: "toolCall", id: "PRIVATE-CALL-ID", name: "test", arguments: {} }],
      });
      reason = /unmatched tool call/;
    } else if (change === "projection") {
      const entry = h.manager.getBranch().find((entry) => entry.type === "message");
      assert.ok(entry && entry.type === "message" && "content" in entry.message);
      entry.message.content = "PRIVATE-EDIT";
      reason = /projected snapshot or checkpoint replay changed/;
    } else if (change === "auth-lookup") {
      h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
        throw new Error("PRIVATE-AUTH-ERROR");
      };
      reason = /authentication or provider lookup failed/;
    } else {
      reason = /session navigation or model\/thinking-level selection/;
    }
    if (change === "navigation") await h.emit("session_before_fork", {});
    else await h.start();
    const messages = h.notifications.map(({ message }) => message).join("\n");
    assert.match(messages, reason);
    assert.doesNotMatch(messages, /PRIVATE-/);
  });

test("normal paired tool suffix applies without diagnostic rejection", async () => {
  const h = await ready();
  h.manager.appendMessage({
    ...assistant(""),
    content: [{ type: "toolCall", id: "call", name: "codemode", arguments: {} }],
  });
  h.manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "codemode",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 3,
  });
  const result = await h.start();
  assert.ok(result && typeof result === "object" && "entries" in result);
  const messages = h.notifications.map(({ message }) => message).join("\n");
  assert.match(messages, /reusing the async checkpoint at the turn boundary/);
  assert.doesNotMatch(messages, /discarded|rejected|Reason:/);
  assert.equal(h.fetches, 1);
});

for (const logging of [true, false])
  test(`foreground adoption rejection diagnostics respect logging=${logging}`, async () => {
    const h = await ready(logging);
    h.setKey("PRIVATE-FOREGROUND-KEY");
    await h.compact("manual");
    const messages = h.notifications.map(({ message }) => message).join("\n");
    assert.equal(
      messages.includes("Async checkpoint application rejected. Reason: request authentication changed."),
      logging,
    );
    assert.doesNotMatch(messages, /PRIVATE-FOREGROUND-KEY/);
  });

test("a discarded candidate is reported once across subsequent context hooks", async () => {
  const h = await ready();
  h.setKey("changed");
  await h.start();
  await h.emit("context", { messages: [] });
  await h.emit("context", { messages: [] });
  assert.equal(h.notifications.filter(({ message }) => message.includes("checkpoint discarded")).length, 1);
});

for (const logging of [true, false])
  test(`binding failure pause uses fixed ordered labels with logging=${logging}`, async () => {
    const h = await ready(logging);
    const originalBranch = JSON.stringify(h.manager.getBranch());
    h.setKey("PRIVATE-ROTATED-TOKEN");
    const replacement = {
      ...h.provider,
      name: "PRIVATE-PROVIDER-NAME",
      stream: h.provider.stream.bind(h.provider),
      streamSimple: h.provider.streamSimple.bind(h.provider),
    };
    h.ctx.modelRegistry.getProvider = () => replacement;
    assert.equal(await h.start(), undefined);
    const notices = h.notifications.map(({ message }) => message).join("\n");
    assert.equal(
      notices.includes(
        "Reason: request authentication changed; provider instance changed; stream function changed; streamSimple function changed.",
      ),
      true,
    );
    assert.doesNotMatch(notices, /PRIVATE-|fixture-key|example\.test|[a-f0-9]{64}/);
    assert.equal(JSON.stringify(h.manager.getBranch()), originalBranch);
    assert.equal(h.fetches, 1);
    await h.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.fetches, 1);
  });

test("binding diagnostics remain silent without UI", async () => {
  const h = await ready();
  h.ctx.hasUI = false;
  const previousCount = h.notifications.length;
  h.setKey("PRIVATE-HEADLESS-TOKEN");
  assert.equal(await h.start(), undefined);
  assert.equal(h.notifications.length, previousCount);
});
