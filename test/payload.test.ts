import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { prepareDispatch } from "../src/payload.js";

describe("message.dispatch payload", () => {
  it("includes the current dispatch context and queued rows", () => {
    const context = makeMessageDispatchHookContext({
      initiator: "agent",
      senderThreadId: "thr_sender",
      queuedMessages: [{ id: "queued_1" }],
      experimental_submission: { pluginId: "source", data: { kind: "example" } },
    });

    const prepared = prepareDispatch(context);
    expect(prepared.payload).toMatchObject({
      initiator: "agent",
      senderThreadId: "thr_sender",
      queuedMessages: [{ id: "queued_1" }],
      queuedMessage: { id: "queued_1" },
      experimentalSubmission: { pluginId: "source", data: { kind: "example" } },
      startedOnBehalfOf: { initiator: "agent", senderThreadId: "thr_sender" },
    });
  });

  it("accepts the legacy single queued-message context", () => {
    const context = makeMessageDispatchHookContext() as unknown as Record<string, unknown>;
    delete context.queuedMessages;
    delete context.initiator;
    delete context.senderThreadId;
    delete context.experimental_submission;
    context.queuedMessage = { id: "queued_legacy", waitingOn: { kind: "time" }, sendAt: 123 };
    context.startedOnBehalfOf = { initiator: "system", senderThreadId: "thr_sender" };

    const prepared = prepareDispatch(context as unknown as MessageDispatchHookContext);
    expect(prepared.payload).toMatchObject({
      initiator: "system",
      senderThreadId: "thr_sender",
      queuedMessages: [{ id: "queued_legacy", waitingOn: { kind: "time" }, sendAt: 123 }],
      queuedMessage: { id: "queued_legacy" },
      experimentalSubmission: null,
      startedOnBehalfOf: { initiator: "system", senderThreadId: "thr_sender" },
    });
  });
});
