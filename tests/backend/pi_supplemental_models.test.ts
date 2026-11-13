import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import { CHECKOUT_ROOT, PI_PACKAGE_ROOT } from "../../src/build_dir";
import { durableModels } from "../../src/agents/durable/models";
import { captureFixture } from "./fixture_subprocess";
import { loadRecording } from "./fixtures/model_response/replay";

// Feature: #9 Mythos uses current Pi metadata and execution without replacing upstream entries.
test("Mythos supplements Settings and Durable catalogs across refreshes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-supplemental-"));
  const fable = (await Bun.file(
    new URL("./fixtures/model_response/fable-5-2.json", import.meta.url)
      .pathname,
  ).json()) as Model<Api>;
  const models = durableModels(root);
  const mythosId = "claude-mythos-5-2";
  const store = async (entries: Model<Api>[]) => {
    await writeFile(
      join(root, "models-store.json"),
      JSON.stringify({
        anthropic: { models: entries, lastModified: Date.now() + 60_000 },
      }),
    );
    const refreshed = await models.refresh({ allowNetwork: false });
    expect([...refreshed.errors]).toEqual([]);
  };
  const listed = async () => {
    const run = await captureFixture(
      [process.execPath, join(CHECKOUT_ROOT, "src/pi_auth.worker.mjs")],
      {
        input: `${JSON.stringify({ action: "list_models", providers: ["anthropic"] })}\n`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(root, "home"),
          PI_OFFLINE: "1",
          RECURSE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT,
          RECURSE_PI_AUTH_PATH: join(root, "auth.json"),
        },
      },
    );
    expect(run.exitCode).toBe(0);
    const reply = JSON.parse(run.stdout.toString().trim());
    expect(reply.kind).toBe("models");
    expect(reply.reasoning_levels_unavailable).toBeUndefined();
    return reply.models.filter(
      (model: { id: string }) => model.id === mythosId,
    );
  };
  try {
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "recorded-stream-no-network" },
      }),
    );
    await store([fable]);
    const mythos = models.getModel("anthropic", mythosId)!;
    expect(mythos).toMatchObject({
      id: mythosId,
      name: "Claude Mythos 5.2",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: fable.cost,
      compat: { forceAdaptiveThinking: true },
    });
    expect(mythos.compat).not.toHaveProperty("allowedFallbackModels");
    expect(models.getModel("anthropic", fable.id)?.compat).toHaveProperty(
      "allowedFallbackModels",
    );
    expect(
      models.getAllModels("anthropic").filter((model) => model.id === mythosId),
    ).toHaveLength(1);
    expect(await listed()).toEqual([
      {
        provider: "anthropic",
        id: mythosId,
        name: "Claude Mythos 5.2",
        context_window: 1_000_000,
        reasoning_levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
    ]);
    const recording = await loadRecording();
    let request: Record<string, any> | undefined;
    const response = await models.completeSimple(
      mythos,
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly NORMAL_MODEL_OK. Do not use tools.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        reasoning: "high",
        fetch: (async (_url, init) => {
          request = JSON.parse(String(init?.body));
          return new Response(
            recording.events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      },
    );
    expect(response.stopReason).toBe("stop");
    expect(request?.model).toBe(mythosId);
    expect(request?.thinking).toMatchObject({ type: "adaptive" });
    expect(request?.output_config.effort).toBe("low");
    expect(request?.messages).toContainEqual({
      role: "system",
      content: [],
      output_config: { effort: "high" },
    });
    await store([fable]);
    expect(models.getModel("anthropic", mythosId)).toEqual(mythos);
    const upstream = { ...mythos, name: "Upstream Mythos" };
    await store([fable, upstream]);
    expect(models.getModel("anthropic", mythosId)?.name).toBe(
      "Upstream Mythos",
    );
    expect(await listed()).toMatchObject([{ name: "Upstream Mythos" }]);
    await store([]);
    expect(models.getModel("anthropic", mythosId)).toEqual(mythos);
    expect(await listed()).toMatchObject([{ name: "Claude Mythos 5.2" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
