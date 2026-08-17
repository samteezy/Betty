/**
 * The vocabulary `wake_betty` and `open_drawer` share: what a capability is, and
 * how to say one out loud to a model.
 *
 * It lives apart from both tools because they need each other — the wake reply
 * has to name the tool that opens what it held back, and that tool has to
 * describe the capabilities the wake reply listed. Keeping the shared half here
 * is what stops that from becoming an import cycle.
 *
 * One capability group is one drawer of Betty's desk, in the words the model
 * sees. `group` is the internal name for the same thing.
 */

/**
 * The tools one capability registered, in registration order. Structurally what
 * `ToolGate.inventory` returns — declared here rather than imported from the
 * gate so the tool layer keeps knowing nothing about it beyond the shape it is
 * handed, which is what keeps these modules portable to `better-email-mcp`.
 */
export interface ToolGroup {
  group: string;
  tools: string[];
  /** Visible right now. */
  open: boolean;
  /** Configured and authenticated, but held back until asked for by name. */
  deferred: boolean;
}

/** "memory, skills and mail" — an Oxford-comma-free list for prose. */
export function joinCapabilities(capabilities: string[]): string {
  if (capabilities.length === 0) return "her tools";
  if (capabilities.length === 1) return capabilities[0];
  return `${capabilities.slice(0, -1).join(", ")} and ${capabilities[capabilities.length - 1]}`;
}

/**
 * An inventory as a bulleted list, ordered the way the tool description reads.
 *
 * Registration order puts memory and skills last — they are gated on the same
 * var as the gate itself, so they register after mail and calendar — while the
 * description leads with them, because they are the reason Betty exists. Sorting
 * against `capabilities` keeps the two halves of the same wake telling the same
 * story. `sort` is stable, so a group the description never names keeps its
 * registration position at the end rather than jumping the queue.
 */
export function renderInventory(capabilities: string[], groups: ToolGroup[]): string {
  const rank = new Map(capabilities.map((name, index) => [name, index]));
  const position = (group: ToolGroup) => rank.get(group.group) ?? capabilities.length;
  return [...groups]
    .filter((group) => group.tools.length > 0)
    .sort((a, b) => position(a) - position(b))
    .map((group) => `- **${group.group}**: ${group.tools.join(", ")}`)
    .join("\n");
}
