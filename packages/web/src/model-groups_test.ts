import { assertEquals } from "@std/assert";
import { buildModelList } from "./model-groups.ts";
import type { ModelInfo } from "./types.ts";

/**
 * The picker's one column: the recent picks first, then one section per
 * provider. The rules worth pinning are the ones a reader would notice as a
 * bug — a model listed twice, a section for a provider with nothing to show,
 * or a recent shortcut offering a model the section below hides.
 */

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, name: id, ...extra };
}

const providers = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "empty", name: "Empty" },
];

const modelsByProvider = new Map<string, ModelInfo[]>([
  [
    "anthropic",
    [model("claude-sonnet"), model("claude-haiku", { enabled: false })],
  ],
  [
    "openai",
    [
      model("gpt-5"),
      model("gpt-5-mini", { input: ["text"] }),
      model("vision", { input: ["text", "image"] }),
    ],
  ],
  ["empty", []],
]);

function list(overrides: Partial<Parameters<typeof buildModelList>[0]> = {}) {
  return buildModelList({
    providers,
    modelsByProvider,
    current: null,
    recent: [],
    query: "",
    enabledOnly: true,
    imageOnly: false,
    ...overrides,
  });
}

Deno.test("model list: the recent section comes first, then the providers", () => {
  const result = list({
    current: { provider: "openai", modelId: "gpt-5" },
    recent: [
      { provider: "anthropic", modelId: "claude-sonnet" },
      // A pick that is also the current model: one row, not two.
      { provider: "openai", modelId: "gpt-5" },
    ],
  });
  assertEquals(
    result.groups.map((g) => g.key),
    ["recent", "anthropic", "openai"],
  );
  assertEquals(
    result.groups[0]!.rows.map((r) => `${r.provider}/${r.model.id}`),
    ["openai/gpt-5", "anthropic/claude-sonnet"],
  );
  // A provider with no models gets no section: an empty heading is one more
  // thing to scroll past.
  assertEquals(
    result.groups.some((g) => g.key === "empty"),
    false,
  );
  // Sections name their provider for the heading.
  assertEquals(result.groups[2]!.title, "OpenAI");
  assertEquals(result.empty, false);
});

Deno.test("model list: the recent section cannot offer what the filters hide", () => {
  const result = list({
    recent: [
      { provider: "anthropic", modelId: "claude-haiku" }, // disabled
      { provider: "openai", modelId: "gone-model" }, // not in the catalog
      { provider: "gone", modelId: "x" }, // provider not offered
    ],
  });
  // Nothing survives, so the section is not drawn at all.
  assertEquals(
    result.groups.some((g) => g.kind === "recent"),
    false,
  );
  assertEquals(
    result.groups.map((g) => g.key),
    ["anthropic", "openai"],
  );
  assertEquals(
    result.groups[0]!.rows.map((r) => r.model.id),
    ["claude-sonnet"],
  );
  // The disabled model is hidden with the setting as the reason.
  assertEquals(result.total, 5);
  assertEquals(result.listable, 4);
});

Deno.test("model list: image-only keeps the models that take images", () => {
  const result = list({
    imageOnly: true,
    recent: [{ provider: "openai", modelId: "vision" }],
  });
  assertEquals(
    result.groups.map((g) => `${g.key}:${g.rows.map((r) => r.model.id)}`),
    ["recent:vision", "openai:vision"],
  );
  assertEquals(result.listable, 1);
});

Deno.test("model list: a search filters the sections, and empty sections go", () => {
  const result = list({ query: "gpt" });
  assertEquals(
    result.groups.map((g) => g.key),
    ["openai"],
  );
  assertEquals(
    result.groups[0]!.rows.map((r) => r.model.id),
    ["gpt-5", "gpt-5-mini"],
  );
  // A search that matches nothing leaves no section and says so through
  // `empty` (the panel turns that into its own sentence).
  const none = list({ query: "no-such-model" });
  assertEquals(none.groups, []);
  assertEquals(none.empty, true);
  // The counts do not follow the search: they answer "is anything available
  // at all", which is a different sentence from "nothing matched".
  assertEquals(none.listable, 4);
});

Deno.test("model list: the recent section is capped", () => {
  const recent = [
    { provider: "openai", modelId: "gpt-5" },
    { provider: "openai", modelId: "gpt-5-mini" },
    { provider: "openai", modelId: "vision" },
    { provider: "anthropic", modelId: "claude-sonnet" },
    { provider: "openai", modelId: "gpt-5" },
    { provider: "anthropic", modelId: "claude-sonnet" },
  ];
  const rows = list({ recent }).groups[0]!.rows;
  // `recentModels` caps what it stores; the list caps what it draws, because
  // the current model can be prepended to a full list.
  assertEquals(rows.length <= 5, true);
  assertEquals(new Set(rows.map((r) => r.model.id)).size, rows.length);
});
