import assert from "node:assert/strict";
import { test } from "vitest";
import { fixture } from "./async-compaction-fixture.js";

for (const mode of ["provider-checkpoint", "text-summary"] as const)
  test(`manual ${mode} preparation returns immediately below threshold and /compact adopts its one job`, async () => {
    const h = fixture({ compactionMode: mode, asyncAutoApply: false, asyncThresholdPercent: 90 });
    h.ctx.isIdle = () => true;
    h.ctx.hasPendingMessages = () => false;
    h.ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 });
    if (mode === "text-summary") {
      const completed = {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The task remains pending; continue the user's request." }],
            },
          ],
        },
      };
      h.setReply(() => new Response(`data: ${JSON.stringify(completed)}\n\n`));
    }
    try {
      await h.emit("session_start", {});
      const command = h.commands.get("background-compaction");
      assert.ok(command);
      await command.handler("prepare", h.ctx as never);
      await h.started;
      assert.equal(h.fetches, 1);
      await command.handler("prepare", h.ctx as never);
      assert.equal(h.fetches, 1);
      const applying = h.compact("manual");
      h.release();
      const result = await applying;
      assert.ok(result && typeof result === "object" && "compaction" in result);
      assert.equal(h.fetches, 1);
    } finally {
      h.release();
      await h.emit("session_shutdown", {});
    }
  });
