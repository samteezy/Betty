/**
 * `open_drawer` — the second tier of the disclosure ladder.
 *
 * `wake_betty` is what a model sees when Betty is asleep; this is what it sees
 * once she is awake and there is more behind her than memory. Mail, calendar,
 * tasks and contacts are configured and authenticated, but their schemas cost
 * more than the memory layer they sit next to, and most conversations never
 * touch them. So waking reveals their *names* and holds back their definitions.
 *
 * **A drawer is a capability group** — the model-facing name for what the gate
 * calls a group. The vocabulary is deliberate: Betty keeps a desk, and a model
 * asking her to open a drawer is a better mental model of "these tools exist,
 * they are just not out on the desktop yet" than any abstract phrasing.
 *
 * It is *not* `DESK_ROOT`. That folder is Betty's bookkeeping — `unfiled.md`,
 * `backlog.md`, `log.md` — and the `organize-desk` skill is what tidies it.
 * Nothing here reads or writes a file. Keep the word "drawer" for capabilities
 * and the word "desk" for the folder, or the two will bleed into each other the
 * way "inbox" would have (see the notes on that in `notes.ts`).
 *
 * Two properties this depends on, both easy to break:
 *
 * 1. **It costs nothing while asleep.** This tool is itself gated, so its
 *    definition is absent until Betty wakes. That is the only reason it can
 *    afford to enumerate the drawers in its description.
 * 2. **The model has to know it is there.** A closed drawer is a capability that
 *    never gets used unless the wake reply names it, which is why the reply lists
 *    the held-back tools by name rather than by count. Progressive disclosure
 *    that hides the fact that something was disclosed is just missing
 *    functionality.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolEnabled, ToolResult } from "./helpers.js";
import { joinCapabilities, ToolGroup } from "./capabilities.js";

export const OPEN_TOOL = "open_drawer";

/** The slice of the gate this tool drives. */
export interface CapabilityGate {
  openGroup(name: string): "opened" | "already-open" | "asleep" | "unknown";
  inventory: ToolGroup[];
}

export interface OpenToolConfig {
  gate: CapabilityGate;
  /** Tool names the user has turned off. */
  disabled: Set<string>;
}

/**
 * A registered tool handle, to the extent this module needs one: enough to
 * rewrite the description, or take the tool away entirely, when the set of
 * drawers changes after registration.
 */
export interface OpenToolHandle {
  update(updates: { description?: string; enabled?: boolean }): void;
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/**
 * Every drawer this tool can open, whether or not it is open right now.
 *
 * Deliberately not "the closed ones": at registration time the gate has not been
 * armed yet, so every group still reads as open and a tool that asked the
 * runtime question would decide it had nothing to do and never register.
 */
export function deferredGroups(gate: CapabilityGate): ToolGroup[] {
  return gate.inventory.filter((group) => group.deferred);
}

/** The subset still waiting to be asked for. */
export function hiddenGroups(gate: CapabilityGate): ToolGroup[] {
  return deferredGroups(gate).filter((group) => !group.open);
}

export function describeOpenTool(names: string[]): string {
  return (
    `Open one of Betty's drawers to reveal the tools inside: ${joinCapabilities(names)}. ` +
    `Their definitions are held back until asked for, so call this rather than telling the ` +
    `user Betty cannot do something on that list.`
  );
}

/**
 * Register the tool, or don't — with nothing deferred there are no drawers, and
 * a tool whose only answer is "nothing to reveal" is worse than its absence.
 * Returns the handle so the composition root can rewrite the description when a
 * capability withdraws after failing to authenticate.
 */
export function registerOpenTool(
  server: McpServer,
  config: OpenToolConfig
): OpenToolHandle | undefined {
  const { gate, disabled } = config;
  if (!toolEnabled(OPEN_TOOL, disabled)) return undefined;

  const names = deferredGroups(gate).map((group) => group.group);
  if (names.length === 0) return undefined;

  return server.tool(
    OPEN_TOOL,
    describeOpenTool(names),
    // A plain string rather than an enum: the set shrinks when a capability
    // fails to authenticate, and a stale enum would reject a name the
    // description still advertised. The handler is the one that knows.
    { drawer: z.string() },
    async ({ drawer }): Promise<ToolResult> => {
      const wanted = drawer.trim().toLowerCase();
      const outcome = gate.openGroup(wanted);

      if (outcome === "unknown") {
        const available = hiddenGroups(gate).map((group) => group.group);
        return text(
          available.length === 0
            ? `Every drawer is already open — everything Betty is configured for is in your tool list.`
            : `Betty has no drawer called "${drawer}". Hers are: ${available.join(", ")}.`
        );
      }

      const group = gate.inventory.find((entry) => entry.group === wanted);
      const tools = group?.tools.join(", ") ?? "";

      // Betty went back to sleep between the model reading this tool and calling
      // it. The request is on file, but nothing is in the tool list yet, and the
      // one useful thing to say is which call fixes that.
      if (outcome === "asleep") {
        return text(
          `Betty is asleep, so the ${wanted} drawer stays shut for now — its tools are not in your ` +
            `tool list. The request is noted: call \`wake_betty\` and ${wanted} comes out with the ` +
            `rest (${tools}).`
        );
      }

      const remaining = hiddenGroups(gate).map((entry) => entry.group);
      const rest = remaining.length > 0 ? ` Still closed: ${remaining.join(", ")}.` : "";

      return text(
        outcome === "already-open"
          ? `The ${wanted} drawer is already open: ${tools}.${rest}`
          : `The ${wanted} drawer is open — these tools are callable now: ${tools}.${rest}`
      );
    }
  ) as unknown as OpenToolHandle;
}
