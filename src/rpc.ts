// The RPC contract between server.ts and the marketplace page (app.tsx).
// app.tsx imports only its type; the schemas run on the server boundary.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { catalogSchema } from "./catalog.js";
import { HOOK_EVENTS, hookSchema } from "./definitions.js";
import { templateSchema } from "./templates.js";

export const registryEntrySchema = z.object({
  ref: z.string(),
  source: z.string(),
  sourceUrl: z.string().nullable(),
  template: templateSchema,
});

export const catalogRecordSchema = z.object({
  url: z.string(),
  name: z.string().nullable(),
  etag: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  catalog: catalogSchema.nullable(),
  error: z.string().nullable(),
});

export const secretInfoSchema = z.object({
  name: z.string(),
  managed: z.boolean(),
  updatedAt: z.number(),
  usedBy: z.number(),
});

export const eventInfoSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  kind: z.enum(["observe", "gate"]),
  summary: z.string(),
});

export const runOutcomeSchema = z.object({
  status: z.enum(["ok", "error", "timeout"]),
  exitCode: z.number().nullable(),
  httpStatus: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  error: z.string().nullable(),
});

export const decisionSchema = z.union([
  z.object({ action: z.literal("proceed") }),
  z.object({ action: z.literal("wait"), reason: z.string(), sendAt: z.number().nullable().optional() }),
  z.object({ action: z.literal("reject"), message: z.string() }),
]);

export const runRecordSchema = z.object({
  id: z.number(),
  hookId: z.string(),
  event: z.string(),
  threadId: z.string().nullable(),
  startedAt: z.number(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "timeout"]),
  exitCode: z.number().nullable(),
  httpStatus: z.number().nullable(),
  decision: z.string().nullable(),
  output: z.string(),
  error: z.string().nullable(),
});

const matchInputSchema = z
  .object({
    projectId: z.string().optional(),
    providerId: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      hooks: z.array(hookSchema),
      hooksError: z.string().nullable(),
      templates: z.array(registryEntrySchema),
      catalogs: z.array(catalogRecordSchema),
      secrets: z.array(secretInfoSchema),
      events: z.array(eventInfoSchema),
      aliases: z.record(z.string(), z.string()),
    }),
  },
  template_use: {
    input: z
      .object({
        ref: z.string().min(1),
        params: z.record(z.string(), z.string()),
        events: z.array(z.enum(HOOK_EVENTS)).optional(),
        id: z.string().optional(),
        match: matchInputSchema.optional(),
        enabled: z.boolean().optional(),
        trusted: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ hooks: z.array(hookSchema), replaced: z.array(z.string()), secrets: z.array(z.string()) }),
  },
  /** Create or replace a hand-written hook; the input is validated by the same schema as the setting. */
  hook_save: {
    input: hookSchema,
    output: hookSchema,
  },
  hook_set_enabled: {
    input: z.object({ id: z.string(), enabled: z.boolean() }).strict(),
    output: hookSchema,
  },
  settings_set_enabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  history_clear: {
    input: z.null(),
    output: z.object({ removed: z.number() }),
  },
  hook_remove: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ removed: z.boolean(), secretsRemoved: z.array(z.string()) }),
  },
  hook_test: {
    input: z.object({ id: z.string(), threadId: z.string().nullable().optional() }).strict(),
    output: z.object({ outcome: runOutcomeSchema, decision: decisionSchema.nullable(), payload: z.unknown() }),
  },
  history_list: {
    input: z
      .object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).max(100_000).optional(),
        hookId: z.string().optional(),
        status: z.enum(["ok", "failed"]).optional(),
      })
      .strict(),
    output: z.object({ runs: z.array(runRecordSchema), total: z.number() }),
  },
  catalog_add: {
    input: z.object({ source: z.string().min(1) }).strict(),
    output: catalogRecordSchema,
  },
  catalog_remove: {
    input: z.object({ source: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  catalog_refresh: {
    input: z.object({ source: z.string().optional() }).strict(),
    output: z.array(catalogRecordSchema),
  },
  secret_set: {
    input: z.object({ name: z.string().min(1), value: z.string().min(1) }).strict(),
    output: z.object({ name: z.string() }),
  },
  secret_remove: {
    input: z.object({ name: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
});
