// The "agent" template setting: inherit the triggering thread's provider and
// model, or pick one with BB's own provider/model picker.
import { useMemo } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_useProviders as useProviders } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@/components/ui/checkbox";
import { agentValueOf, parseAgentValue, type AgentChoice } from "../agent";

const REASONING = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
type Reasoning = (typeof REASONING)[number];
const TIERS = ["default", "fast"] as const;
type Tier = (typeof TIERS)[number];

function asReasoning(value: string): Reasoning {
  return (REASONING as readonly string[]).includes(value) ? (value as Reasoning) : "medium";
}

export function AgentField({ value, onChange, inheritLabel = "Same provider and model as the thread that triggers it" }: { value: string; onChange: (next: string) => void; inheritLabel?: string }) {
  const { providers, status } = useProviders();
  const choice = useMemo<AgentChoice>(() => {
    const parsed = parseAgentValue(value);
    return "error" in parsed ? { mode: "inherit", providerId: "", model: "", reasoningLevel: "", serviceTier: "" } : parsed;
  }, [value]);
  const firstProvider = providers.find((provider) => provider.available) ?? providers[0];
  const pickerValue = {
    providerId: choice.providerId || firstProvider?.id || "",
    model: choice.model,
    reasoningLevel: asReasoning(choice.reasoningLevel),
    ...(choice.serviceTier && (TIERS as readonly string[]).includes(choice.serviceTier) ? { serviceTier: choice.serviceTier as Tier } : {}),
  };
  const providerName = providers.find((provider) => provider.id === choice.providerId)?.displayName ?? choice.providerId;

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-state-hover">
        <Checkbox
          checked={choice.mode === "inherit"}
          onCheckedChange={(checked) => {
            if (checked === true) onChange("inherit");
            else onChange(agentValueOf({ mode: "pick", providerId: pickerValue.providerId, model: "", reasoningLevel: "", serviceTier: "" }));
          }}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium text-foreground">{inheritLabel}</span>
          <span className="block text-muted-foreground">Uses whatever the triggering thread was running with, including its reasoning level.</span>
        </span>
      </label>
      {choice.mode === "pick" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
          {status === "ready" && pickerValue.providerId !== "" ? (
            <ProviderModelPicker
              value={pickerValue}
              onChange={(next) => onChange(agentValueOf({ mode: "pick", providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel, serviceTier: next.serviceTier ?? "" }))}
            />
          ) : (
            <span className="text-xs text-muted-foreground">{status === "error" ? "Could not load providers." : "Loading providers…"}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {choice.model ? `${providerName} · ${choice.model}${choice.reasoningLevel ? ` · ${choice.reasoningLevel}` : ""}` : `${providerName || "provider"} with its default model`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
