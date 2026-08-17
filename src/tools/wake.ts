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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolEnabled, ToolResult } from "./helpers.js";

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

/** "memory, skills and mail" — an Oxford-comma-free list for prose. */
export function joinCapabilities(capabilities: string[]): string {
  if (capabilities.length === 0) return "her tools";
  if (capabilities.length === 1) return capabilities[0];
  return `${capabilities.slice(0, -1).join(", ")} and ${capabilities[capabilities.length - 1]}`;
}

export function registerWakeTool(server: McpServer, config: WakeToolConfig): void {
  const { gate, capabilities, instructions, disabled } = config;

  // Registering a gate with no way through it would strand every other tool.
  // The composition root checks the same set before arming, so this cannot
  // contradict it — it is the guarantee restated for a direct caller.
  if (!toolEnabled(WAKE_TOOL, disabled)) return;

  server.tool(
    WAKE_TOOL,
    `Load Betty's instructions and bring her tools online: ${joinCapabilities(
      capabilities
    )}. Call before answering anything about the user, their projects, or people they know. Pass loaded=true if you already have her instructions.`,
    {
      loaded: z.boolean().optional(),
    },
    async ({ loaded }): Promise<ToolResult> => {
      const woke = gate.wake();

      if (loaded) {
        return text(
          woke
            ? "Betty's tools are back online. You already have her instructions — carry on."
            : "Betty is already awake."
        );
      }

      try {
        return text(await instructions());
      } catch (err) {
        // The wake itself succeeded, so this is not an error result: the tools
        // are live and the model can proceed. Say what is missing and let it.
        const message = err instanceof Error ? err.message : String(err);
        return text(
          `Betty's tools are online, but her wake-betty skill could not be read (${message}). ` +
            `Call list_skills to see what is available.`
        );
      }
    }
  );
}
