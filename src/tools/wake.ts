/**
 * `wake_betty` — the one tool that is visible before Betty wakes.
 *
 * Everything about it is shaped by the fact that its definition sits in the
 * context window of every request forever, whether or not Betty is ever used.
 * So: no `.describe()` on the parameter (the tool description carries it), no
 * verbose schema, and a description that has to earn the call in one sentence.
 *
 * `loaded` is what makes a short re-arm cheap. A model that already has Betty's
 * instructions in the conversation passes `loaded: true` and gets the tools back
 * for a handful of tokens instead of re-reading the whole skill. Omitting it is
 * the safe direction — the worst case is re-sending instructions the model
 * already had, never booting without them.
 *
 * The *reply* is under no such budget: it is paid once per wake rather than on
 * every request, which makes it the right place to spend words. It has one job
 * the skill body cannot do — waking is the only moment in an MCP session when a
 * model's tool list is wrong. The gate fires `tools/list_changed`, but until the
 * client acts on it the model is looking at a list holding exactly `wake_betty`,
 * and a model that does not believe a tool exists will not call it. So the reply
 * names them, grouped by capability, and closes by pointing at `list_skills` —
 * the difference between "Betty is awake" and knowing what to ask her for.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolEnabled, ToolResult } from "./helpers.js";
import { joinCapabilities, renderInventory, ToolGroup } from "./capabilities.js";
import { OPEN_TOOL } from "./open.js";

export const WAKE_TOOL = "wake_betty";

export interface WakeToolConfig {
  /** Opened by the handler. Returns false when it was already open. */
  gate: { wake(): boolean };
  /**
   * Capabilities named in the description, in the order they should read —
   * e.g. `["memory", "skills", "mail"]`. Built from what is actually
   * configured, so the description never advertises tools that aren't there.
   */
  capabilities: string[];
  /** The instructions to hand back, read on demand rather than at startup. */
  instructions: () => Promise<string>;
  /**
   * The tools the wake just revealed, for the reply to name. Read at call time
   * because registration is still in progress when this tool is registered.
   * Optional: with nothing to list the reply still says the list has changed,
   * which is the half a model cannot work out for itself.
   */
  inventory?: () => ToolGroup[];
  /**
   * Tool names the user has turned off.
   *
   * Passed in rather than read from `process.env` here, because the composition
   * root decides whether to arm the gate from the same set. Two independent
   * reads could disagree — a `DISABLED_TOOLS` in the process environment but not
   * in the environment `registerAll` was handed — and that particular
   * disagreement arms a gate whose key never registers, disabling every tool for
   * the life of the connection.
   */
  disabled: Set<string>;
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/**
 * What the model needs before the instructions make sense: the tool list it is
 * holding is out of date, here is what it is missing, and here is what exists
 * but has deliberately not been sent.
 *
 * The held-back capabilities are listed by tool name, not by count. A name is a
 * few tokens and it is what makes the capability *thinkable* — "calendar (4
 * tools)" tells a model nothing about whether calling it would answer the
 * question in front of it, while `list_events, search_events` does.
 */
export function wakePreamble(capabilities: string[], groups: ToolGroup[]): string {
  const listing = renderInventory(
    capabilities,
    groups.filter((group) => group.open)
  );
  const held = renderInventory(
    capabilities,
    groups.filter((group) => !group.open)
  );

  const opening = listing
    ? "Betty is awake. Every tool below was hidden from you a moment ago and is callable now — " +
      "if your tool list still shows only `wake_betty`, re-read it before deciding what you can do:\n\n" +
      `${listing}`
    : "Betty is awake and her tools are live. If your tool list still shows only `wake_betty`, " +
      "re-read it — it changed just now.";

  if (!held) {
    return listing
      ? `${opening}\n\nThat list is the whole of what Betty can do here; anything not on it is not configured for this user. Her instructions follow.`
      : opening;
  }

  return (
    `${opening}\n\n` +
    `These are configured too, but still in her drawers — their tool definitions are held back to ` +
    `keep your context small. Call \`${OPEN_TOOL}\` with a drawer name to bring one out:\n\n` +
    `${held}\n\n` +
    `Between the two lists is everything Betty can do here; anything on neither is not configured for ` +
    `this user. Her instructions follow.`
  );
}

/**
 * The closing nudge. Last thing read, so it is the one instruction most likely
 * to survive into the model's next move — and the failure it targets is a model
 * that wakes Betty, thanks her, and then answers from its own assumptions
 * anyway, never asking what she already knows or has been taught.
 *
 * Tools and skills are named as two separate questions on purpose. They fail
 * separately: a model can have the full tool list and still not know the user
 * wrote a skill describing exactly how they want this done, and the tool list
 * alone reads like the whole answer.
 */
const WAKE_FOOTER =
  "Two things worth asking before you answer. The tools listed above are what Betty *can* do — " +
  "use them rather than assuming, starting with a search of her memory. `list_skills` is what this " +
  "user has *taught* her to do; one of those may already cover the task in front of you, and it is " +
  "one cheap call to find out.";

/**
 * The one sentence that has to earn the call, from a context window that has
 * never heard of Betty. Extracted so the composition root can rewrite it when a
 * capability turns out not to authenticate — the description is the only part of
 * Betty a model sees before it commits to anything.
 */
export function describeWakeTool(capabilities: string[]): string {
  return (
    `Load Betty's instructions and bring her tools online: ${joinCapabilities(capabilities)}. ` +
    `Call before answering anything about the user, their projects, or people they know. ` +
    `Pass loaded=true if you already have her instructions.`
  );
}

/**
 * A registered tool handle, to the extent this module's caller needs one:
 * enough to rewrite the description after registration.
 */
export interface WakeToolHandle {
  update(updates: { description?: string; enabled?: boolean }): void;
}

export function registerWakeTool(
  server: McpServer,
  config: WakeToolConfig
): WakeToolHandle | undefined {
  const { gate, capabilities, instructions, inventory, disabled } = config;

  // Registering a gate with no way through it would strand every other tool.
  // The composition root checks the same set before arming, so this cannot
  // contradict it — it is the guarantee restated for a direct caller.
  if (!toolEnabled(WAKE_TOOL, disabled)) return undefined;

  return server.tool(
    WAKE_TOOL,
    describeWakeTool(capabilities),
    {
      loaded: z.boolean().optional(),
    },
    async ({ loaded }): Promise<ToolResult> => {
      const woke = gate.wake();

      if (loaded) {
        return text(
          woke
            ? "Betty's tools are in your tool list again. You already have her instructions — carry on."
            : "Betty is already awake."
        );
      }

      const preamble = wakePreamble(capabilities, inventory?.() ?? []);

      try {
        return text(`${preamble}\n\n---\n\n${await instructions()}\n\n---\n\n${WAKE_FOOTER}`);
      } catch (err) {
        // The wake itself succeeded, so this is not an error result: the tools
        // are live and the model can proceed. The preamble already named them,
        // which is most of what the skill would have said about getting started.
        const message = err instanceof Error ? err.message : String(err);
        return text(
          `${preamble}\n\nHer wake-betty skill could not be read (${message}), so you are working ` +
            `without it. Call \`list_skills\` to see what else this user has taught her.`
        );
      }
    }
  );
}
