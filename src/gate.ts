/**
 * The wake gate.
 *
 * Betty's tools are registered as normal but start disabled, so the client's
 * first `tools/list` returns exactly one tool: `wake_betty`. Calling it enables
 * the rest and fires a single `notifications/tools/list_changed`.
 *
 * Two things this buys:
 *
 * 1. **Betty carries her own bootstrap.** Without the gate, `wake-betty` only
 *    loads if the user writes a client-side rule ("if I mention Betty,
 *    load_skill wake-betty") — the one part of Betty that has to be re-done on
 *    every platform. An always-visible tool whose description is the trigger
 *    travels with her.
 * 2. **Tokens.** A full configuration costs ~2,000 schema tokens on every
 *    request; the gate holds that at ~60 until Betty is actually wanted.
 *
 * The gate lives in process memory, so it is per-*connection*, not per-chat:
 * MCP has no concept of a conversation, and the server sees one `initialize`
 * followed by an undifferentiated stream of calls. On a host that keeps one
 * server process across chats (Claude Desktop), waking would otherwise be
 * sticky for the life of the app. `rearmMs` is the answer — after a quiet
 * stretch the gate closes again, so the next chat, or the next hour of
 * unrelated work in a long coding session, starts un-gated.
 *
 * Re-arming mid-conversation is safe because the cost of being wrong is one
 * `wake_betty {loaded: true}` call, which re-enables the tools without
 * re-sending instructions the model already has.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The slice of the SDK's `RegisteredTool` the gate touches. */
export interface GatedTool {
  enabled: boolean;
}

/** The part of `McpServer` the gate needs to notify through. */
export interface ListChangedNotifier {
  sendToolListChanged(): void;
}

export interface ToolGateOptions {
  /**
   * Close the gate again after this many milliseconds with no tool call.
   * 0 (or omitted) never re-arms.
   */
  rearmMs?: number;
  /** Injectable clock, so tests don't wait on wall time. */
  now?: () => number;
}

/** How often {@link ToolGate.startSweeping} checks for idleness. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * McpServer methods that register a tool and hand back a handle. Both are
 * intercepted so a tool cannot reach the client without the gate holding it —
 * `tool()` is what this codebase calls today, `registerTool()` is what the SDK
 * says to call instead.
 */
const TOOL_REGISTRARS = new Set<string | symbol>(["tool", "registerTool"]);

export class ToolGate {
  private readonly handles: GatedTool[] = [];
  private readonly notifier: ListChangedNotifier;
  private readonly rearmMs: number;
  private readonly now: () => number;
  private lastActivity: number;
  private open = true;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(notifier: ListChangedNotifier, options: ToolGateOptions = {}) {
    this.notifier = notifier;
    this.rearmMs = options.rearmMs ?? 0;
    this.now = options.now ?? Date.now;
    this.lastActivity = this.now();
  }

  /** True while the gated tools are visible. */
  get awake(): boolean {
    return this.open;
  }

  /** How many tools the gate is holding. */
  get size(): number {
    return this.handles.length;
  }

  /**
   * Wrap a server so every tool registered through it is collected, and every
   * call through it counts as activity.
   *
   * A Proxy rather than a `{ tool }` stand-in, for two reasons. A stand-in
   * throws the moment a tool module reaches for any other McpServer method —
   * and `tool()` is deprecated in this SDK in favour of `registerTool()`, so
   * that day is coming. But a Proxy that forwarded registrations blind would be
   * worse than throwing: a tool registered through a method the gate doesn't
   * know about would never be collected, and would sit *visible* while Betty is
   * asleep. Hence intercepting both registration methods, and passing
   * everything else (prompts, resources, notifications) straight through — none
   * of which the gate has any business touching.
   */
  wrap(server: McpServer): McpServer {
    return new Proxy(server, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (!TOOL_REGISTRARS.has(prop)) {
          // Bound to the real server: an SDK method invoked with the proxy as
          // `this` would break on any private field it reads internally.
          return value.bind(target);
        }
        return (...args: unknown[]): GatedTool => {
          const handle = (value as (...a: unknown[]) => GatedTool).apply(
            target,
            this.instrument(args)
          );
          this.handles.push(handle);
          return handle;
        };
      },
    });
  }

  /**
   * Replace the handler with one that stamps activity first.
   *
   * The callback is the last argument of every `tool()` overload and of
   * `registerTool()`. Stamping here rather than in the transport keeps the gate
   * ignorant of the SDK's request plumbing — a handler call is the only kind of
   * activity that means "Betty is in use".
   */
  private instrument(args: unknown[]): unknown[] {
    const last = args.length - 1;
    const handler = args[last];
    if (typeof handler !== "function") return args;
    const instrumented = [...args];
    instrumented[last] = (...handlerArgs: unknown[]) => {
      this.touch();
      return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
    };
    return instrumented;
  }

  /** Record that Betty was used just now. */
  touch(): void {
    this.lastActivity = this.now();
  }

  /**
   * Close the gate for the first time. Called before the transport connects, so
   * no notification is warranted — the client has not yet asked for a list.
   */
  arm(): void {
    for (const handle of this.handles) handle.enabled = false;
    this.open = false;
  }

  /**
   * Open the gate. Returns false if it was already open, which is what makes a
   * duplicate `wake_betty` harmless.
   *
   * Sets `enabled` directly and sends one notification at the end rather than
   * calling the SDK's `enable()` per tool, which would emit one
   * `tools/list_changed` per tool for a list that only changes once.
   */
  wake(): boolean {
    this.touch();
    if (this.open) return false;
    for (const handle of this.handles) handle.enabled = true;
    this.open = true;
    this.notifier.sendToolListChanged();
    return true;
  }

  /** Close the gate again, notifying the client. Returns false if already shut. */
  rearm(): boolean {
    if (!this.open) return false;
    for (const handle of this.handles) handle.enabled = false;
    this.open = false;
    this.notifier.sendToolListChanged();
    return true;
  }

  /** Re-arm if the gate is open and nothing has touched it for `rearmMs`. */
  sweep(): boolean {
    if (!this.rearmMs || !this.open) return false;
    if (this.now() - this.lastActivity < this.rearmMs) return false;
    return this.rearm();
  }

  /**
   * Start the idle check. Kept out of `registerAll` — which stays free of I/O
   * and timers so `server.test.ts` can drive the whole gating matrix — and
   * called from `connectAll` instead, alongside the other live wiring.
   */
  startSweeping(): void {
    if (!this.rearmMs || this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Never a reason to hold the process open on its own.
    this.sweeper.unref?.();
  }

  /** Stop the idle check. */
  stopSweeping(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

/**
 * Minutes of quiet before the gate closes again, from
 * `BETTY_WAKE_REARM_MINUTES`. Default 10; `0` pins the gate open once woken.
 */
export const DEFAULT_REARM_MINUTES = 10;

export function parseRearmMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REARM_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(
      `BETTY_WAKE_REARM_MINUTES must be a non-negative number of minutes (got "${raw}")`
    );
  }
  return minutes * 60_000;
}
