// Supplemental Anthropic names use Pi's current metadata and execution path.
// Mythos 5.2 has Fable 5.2's specifications, but not its fallback permissions:
// https://platform.claude.com/docs/en/models/mythos-5-2/overview
import type { AnyModel, Provider } from "@earendil-works/pi-ai";

function supplementalModels<T extends AnyModel>(
  models: readonly T[],
): readonly T[] {
  if (models.some((model) => model.id === "claude-mythos-5-2")) return models;
  const fable = models.find(
    (model) =>
      model.id === "claude-fable-5-2" &&
      (model.type === undefined || model.type === "chat"),
  );
  if (!fable) return models;
  const mythos = {
    ...fable,
    id: "claude-mythos-5-2",
    name: "Claude Mythos 5.2",
  };
  if ("compat" in mythos && mythos.compat) {
    const compat = { ...mythos.compat };
    if ("allowedFallbackModels" in compat) delete compat.allowedFallbackModels;
    mythos.compat = compat;
  }
  return [...models, mythos];
}

/** Fill a missing Mythos entry from Fable after each catalog refresh. */
export function withSupplementalModels(provider: Provider): Provider {
  if (provider.id !== "anthropic") return provider;
  return new Proxy(provider, {
    get(target, key) {
      if (key === "getModels")
        return () => supplementalModels(target.getModels());
      if (key === "getAllModels")
        return () =>
          supplementalModels(target.getAllModels?.() ?? target.getModels());
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
