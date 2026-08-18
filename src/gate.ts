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
 * 2. **Tokens.** A full configuration costs ~2,166 schema tokens on every
 *    request; the gate holds that at ~104 until Betty is actually wanted.
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

/**
 * The tools one capability registered, in registration order.
 *
 * The gate is the only place that sees every registration, so it is also the
 * only place that can tell `wake_betty` what it just revealed — a model whose
 * client has not yet re-fetched `tools/list` otherwise has no way to know the
 * names it may now call.
 */
export interface ToolGroup {
  group: string;
  tools: string[];
  /** Whether these tools are visible right now. */
  open: boolean;
  /**
   * True for a capability that waking does *not* reveal: it is configured and
   * authenticated, but its schemas stay out of the context window until
   * something asks for them by name.
   */
  deferred: boolean;
}

/**
 * What {@link ToolGate.openGroup} did.
 *
 * `asleep` is the one that is easy to leave out and wrong to fold into
 * `opened`: the request is recorded, but nothing became visible, and a caller
 * that reported success would send the model after tools its next `tools/list`
 * would not contain.
 */
export type OpenOutcome = "opened" | "already-open" | "asleep" | "unknown";

export interface WrapOptions {
  /**
   * Hold this group back at wake, to be revealed only on request.
   *
   * Defaults to false, which is the safe direction: a capability nobody marked
   * behaves exactly as it did before there were tiers, rather than silently
   * going missing.
   */
  deferred?: boolean;
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

/** One capability's registrations, and what the gate has decided about them. */
interface GroupState {
  name: string;
  tools: string[];
  handles: GatedTool[];
  deferred: boolean;
  /**
   * Opened by name at some point on this connection. A re-arm closes it, and
   * the next wake opens it again — a model that needed mail an hour ago should
   * not have to rediscover that after an idle stretch.
   */
  requested: boolean;
  /**
   * Configured, but its backend never authenticated. Withdrawn groups are
   * invisible in every sense: never enabled, never listed, never nameable.
   */
  withdrawn: boolean;
}

export class ToolGate {
  private readonly groups: GroupState[] = [];
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
    return this.groups.reduce((total, group) => total + group.handles.length, 0);
  }

  /**
   * What the gate is holding, grouped by the capability that registered it.
   *
   * Withdrawn groups are absent rather than flagged: a capability that failed to
   * authenticate should not be something a model can see, name, or offer the
   * user. So are empty ones — a capability every one of whose tools the user put
   * in `DISABLED_TOOLS` is, from the model's side, indistinguishable from a
   * capability that was never configured, and naming it would advertise a drawer
   * with nothing in it. Copied on the way out — `wake_betty` renders this into
   * its reply, and the one thing worse than a stale list is a caller mutating
   * the live one.
   */
  get inventory(): ToolGroup[] {
    return this.groups
      .filter((group) => !group.withdrawn && group.handles.length > 0)
      .map((group) => ({
        group: group.name,
        tools: [...group.tools],
        open: group.handles.every((handle) => handle.enabled),
        deferred: group.deferred,
      }));
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
   *
   * `group` labels whatever registers through this wrapper — one call per
   * capability, so `wake_betty` can say *which* tools it just brought online
   * rather than listing two dozen names flat, and so a capability can be
   * revealed, held back, or withdrawn as a unit. The tool modules still know
   * nothing: the composition root supplies the label, as it already supplies
   * the same names to the wake tool's description.
   */
  wrap(server: McpServer, group = "tools", options: WrapOptions = {}): McpServer {
    this.groupFor(group).deferred = options.deferred ?? false;
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
          this.record(group, handle, args[0]);
          return handle;
        };
      },
    });
  }

  /**
   * File a registered tool under its capability. The name is the first argument
   * of both `tool()` and `registerTool()`; anything else is a call shape the
   * gate does not recognize, and a missing line in the wake message is a better
   * failure than a fabricated one. The handle is held either way — a tool the
   * gate cannot name is still a tool it must not leave visible.
   */
  private record(group: string, handle: GatedTool, name: unknown): void {
    const state = this.groupFor(group);
    state.handles.push(handle);
    if (typeof name === "string") state.tools.push(name);
  }

  /** The group's state, created on first sight. */
  private groupFor(name: string): GroupState {
    const existing = this.groups.find((group) => group.name === name);
    if (existing) return existing;
    const created: GroupState = {
      name,
      tools: [],
      handles: [],
      deferred: false,
      requested: false,
      withdrawn: false,
    };
    this.groups.push(created);
    return created;
  }

  /** Whether this group's tools should be visible while Betty is awake. */
  private shouldReveal(group: GroupState): boolean {
    if (group.withdrawn) return false;
    return !group.deferred || group.requested;
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

  /** Hide every tool the gate holds, whatever group it belongs to. */
  private shutAll(): void {
    for (const group of this.groups) {
      for (const handle of group.handles) handle.enabled = false;
    }
  }

  /**
   * Close the gate for the first time. Called before the transport connects, so
   * no notification is warranted — the client has not yet asked for a list.
   */
  arm(): void {
    this.shutAll();
    this.open = false;
  }

  /**
   * Open the gate. Returns false if it was already open, which is what makes a
   * duplicate `wake_betty` harmless.
   *
   * Reveals every group except the deferred ones, which stay hidden until
   * something calls {@link openGroup} for them by name — with the exception of a
   * group already opened that way on this connection, which comes back. A
   * re-arm is meant to cost the model a sentence, not the work of rediscovering
   * that it needed mail.
   *
   * Sets `enabled` directly and sends one notification at the end rather than
   * calling the SDK's `enable()` per tool, which would emit one
   * `tools/list_changed` per tool for a list that only changes once.
   */
  wake(): boolean {
    this.touch();
    if (this.open) return false;
    for (const group of this.groups) {
      if (!this.shouldReveal(group)) continue;
      for (const handle of group.handles) handle.enabled = true;
    }
    this.open = true;
    this.notifier.sendToolListChanged();
    return true;
  }

  /**
   * Reveal one deferred capability by name, and remember that it was wanted.
   *
   * Every outcome is one the client's next `tools/list` will agree with, which
   * is the whole job: a group that is withdrawn, unknown, or holds no tools at
   * all is refused, and a request made while Betty is asleep is recorded and
   * reported as recorded rather than as done. The caller turns each into
   * something the model can act on.
   */
  openGroup(name: string): OpenOutcome {
    this.touch();
    const group = this.groups.find((entry) => entry.name === name);
    // An empty group is a capability whose tools were all disabled by the user.
    // It is absent from `inventory` for the same reason it is refused here:
    // opening it would reveal nothing and say it revealed something.
    if (!group || group.withdrawn || group.handles.length === 0) return "unknown";
    group.requested = true;
    // Recorded, not opened. Revealing one capability while every other tool is
    // hidden would be the wrong shape, so the next wake honours this instead.
    if (!this.open) return "asleep";
    if (group.handles.every((handle) => handle.enabled)) return "already-open";
    for (const handle of group.handles) handle.enabled = true;
    this.notifier.sendToolListChanged();
    return "opened";
  }

  /**
   * Take a capability out of service — configured, but its backend never
   * authenticated. Permanent for the life of the connection, and stronger than
   * closing: a withdrawn group drops out of {@link inventory} too, so nothing
   * downstream can name it to a model as something Betty might do.
   */
  withdraw(name: string): boolean {
    const group = this.groups.find((entry) => entry.name === name);
    if (!group || group.withdrawn) return false;
    group.withdrawn = true;
    group.requested = false;
    for (const handle of group.handles) handle.enabled = false;
    if (this.open) this.notifier.sendToolListChanged();
    return true;
  }

  /** Close the gate again, notifying the client. Returns false if already shut. */
  rearm(): boolean {
    if (!this.open) return false;
    this.shutAll();
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
