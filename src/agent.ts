// The `agent` template setting: who runs a spawned thread. Pure, so the
// frontend can import it without dragging in Node modules.
export interface AgentChoice {
  mode: "inherit" | "pick";
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier: string;
}

/** Parse an `agent` param value: `inherit`, a provider id, or JSON. */
export function parseAgentValue(raw: string): AgentChoice | { error: string } {
  const value = raw.trim();
  if (value === "" || value === "inherit") return { mode: "inherit", providerId: "", model: "", reasoningLevel: "", serviceTier: "" };
  if (value.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { error: "agent value is not valid JSON" };
    }
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    if (typeof record.providerId !== "string" || record.providerId === "") return { error: "agent JSON needs a providerId" };
    const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
    return { mode: "pick", providerId: record.providerId, model: text("model"), reasoningLevel: text("reasoningLevel"), serviceTier: text("serviceTier") };
  }
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return { mode: "pick", providerId: value, model: "", reasoningLevel: "", serviceTier: "" };
  return { error: `"${value}" is not inherit, a provider id, or agent JSON` };
}

export function agentValueOf(choice: AgentChoice): string {
  if (choice.mode === "inherit") return "inherit";
  const record: Record<string, string> = { providerId: choice.providerId };
  if (choice.model) record.model = choice.model;
  if (choice.reasoningLevel) record.reasoningLevel = choice.reasoningLevel;
  if (choice.serviceTier) record.serviceTier = choice.serviceTier;
  return JSON.stringify(record);
}

