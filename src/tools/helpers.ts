export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Names the write tools had before 0.4.0 split them by target. Honoured here
 * rather than by registering aliases: a registered alias would cost schema
 * tokens on every request forever, while a DISABLED_TOOLS translation is free
 * and keeps an existing config working across the upgrade.
 */
// A Map, not an object literal: a plain object would resolve "constructor",
// "toString" and friends off Object.prototype, so `?? []` would not fire and
// DISABLED_TOOLS=constructor would throw "not iterable" here — at registration
// time, making the server fail to start on a merely unrecognized tool name.
const RENAMED_TOOLS = new Map<string, string[]>([
  ["append_note", ["append_memory", "append_skill"]],
  ["replace_section", ["replace_memory_section", "replace_skill_section"]],
]);

/**
 * `raw` defaults to `process.env.DISABLED_TOOLS` for the registration-time
 * callers in each tool module. The composition root passes its own `env` value
 * instead, since it never reaches for `process.env` directly.
 */
export function parseDisabledTools(raw = process.env.DISABLED_TOOLS ?? ""): Set<string> {
  if (!raw.trim()) return new Set();
  const names = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const disabled = new Set(names);
  for (const name of names) {
    for (const current of RENAMED_TOOLS.get(name) ?? []) disabled.add(current);
  }
  return disabled;
}

export function toolEnabled(name: string, disabled: Set<string>): boolean {
  return !disabled.has(name.toLowerCase());
}

export function toLean<T>(
  items: T[],
  alwaysKeys: (keyof T)[],
  truthyKeys: (keyof T)[] = []
): Record<string, unknown>[] {
  return items.map((item) => {
    const lean: Record<string, unknown> = {};
    for (const k of alwaysKeys) lean[k as string] = item[k];
    for (const k of truthyKeys) {
      const v = item[k];
      if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) {
        lean[k as string] = v;
      }
    }
    return lean;
  });
}
