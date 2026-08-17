import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_REARM_MINUTES, ToolGate, parseRearmMs } from "./gate";

/**
 * The gate's whole job is flipping `enabled` on the handles `server.tool()`
 * hands back, so a stub that returns one is all it takes to drive it.
 */
function stubServer() {
  const handles: Array<{ name: string; enabled: boolean }> = [];
  const notified: number[] = [];
  const register = (name: string, ...rest: unknown[]) => {
    const handle = { name, enabled: true, handler: rest[rest.length - 1] };
    handles.push(handle);
    return handle;
  };
  const server = {
    tool: register,
    /** The SDK's replacement for tool(); the gate has to hold these too. */
    registerTool: register,
    sendToolListChanged: () => notified.push(handles.filter((h) => h.enabled).length),
  };
  return { server: server as unknown as McpServer, handles, notified };
}

/** A gate with `count` tools registered through it, and a controllable clock. */
function setup(count = 3, options: { rearmMs?: number } = {}) {
  const { server, handles, notified } = stubServer();
  let clock = 1_000;
  const gate = new ToolGate(server, { ...options, now: () => clock });
  const wrapped = gate.wrap(server);
  const calls: string[] = [];
  for (let i = 0; i < count; i++) {
    (wrapped as unknown as { tool: (...a: unknown[]) => unknown }).tool(
      `tool_${i}`,
      "",
      {},
      async () => {
        calls.push(`tool_${i}`);
        return "ok";
      }
    );
  }
  return {
    gate,
    handles,
    notified,
    calls,
    wrapped,
    advance: (ms: number) => {
      clock += ms;
    },
    enabledCount: () => handles.filter((h) => h.enabled).length,
    callTool: (i: number) =>
      (handles[i] as unknown as { handler: () => Promise<string> }).handler(),
  };
}

describe("ToolGate.wrap()", () => {
  it("collects a handle for every tool registered through it", () => {
    const { gate } = setup(4);
    expect(gate.size).toBe(4);
  });

  it("gates registerTool() too, not just the deprecated tool()", () => {
    // The SDK deprecates tool() in favour of registerTool(). A wrapper that
    // passed the newer one through would leave that tool visible while Betty is
    // asleep — a silent hole, which is worse than a loud failure.
    const { server, handles } = stubServer();
    const gate = new ToolGate(server);
    const wrapped = gate.wrap(server) as unknown as {
      registerTool: (...a: unknown[]) => unknown;
    };

    wrapped.registerTool("modern", {}, async () => "ok");
    gate.arm();

    expect(gate.size).toBe(1);
    expect(handles.find((h) => h.name === "modern")?.enabled).toBe(false);
  });

  it("passes other server methods through to the real server", () => {
    // A `{ tool }` stand-in threw here, which is a trap for the next person to
    // touch a tool module.
    const { server, notified } = stubServer();
    const gate = new ToolGate(server);
    const wrapped = gate.wrap(server);

    expect(() => wrapped.sendToolListChanged()).not.toThrow();
    expect(notified).toHaveLength(1);
  });

  it("does not mutate the caller's argument list", () => {
    const { server } = stubServer();
    const gate = new ToolGate(server);
    const handler = async () => "ok";
    const args: unknown[] = ["named", {}, handler];

    (gate.wrap(server) as unknown as { tool: (...a: unknown[]) => unknown }).tool(...args);

    expect(args[2]).toBe(handler);
  });

  it("passes the registration through to the real server", () => {
    const { handles } = setup(2);
    expect(handles.map((h) => h.name)).toEqual(["tool_0", "tool_1"]);
  });

  it("records what it is holding, grouped by capability", () => {
    // wake_betty reads this back to a model whose tool list has not caught up
    // with the notification yet.
    const { server } = stubServer();
    const gate = new ToolGate(server);
    const mail = gate.wrap(server, "mail") as unknown as { tool: (...a: unknown[]) => unknown };
    const memory = gate.wrap(server, "memory") as unknown as {
      registerTool: (...a: unknown[]) => unknown;
    };

    mail.tool("list_messages", "", {}, async () => "ok");
    memory.registerTool("search_notes", {}, async () => "ok");
    mail.tool("send_message", "", {}, async () => "ok");

    expect(gate.inventory).toEqual([
      { group: "mail", tools: ["list_messages", "send_message"], open: true, deferred: false },
      { group: "memory", tools: ["search_notes"], open: true, deferred: false },
    ]);
  });

  it("hands out a copy, not the live registry", () => {
    const { gate } = setup(1);
    gate.inventory[0].tools.push("invented_tool");
    expect(gate.inventory[0].tools).toEqual(["tool_0"]);
  });

  it("leaves the tool's return value alone", async () => {
    const { callTool } = setup(1);
    await expect(callTool(0)).resolves.toBe("ok");
  });
});

describe("deferred capabilities", () => {
  /** Two core tools and two deferred ones, the shape a real server has. */
  function tiered() {
    const { server, handles, notified } = stubServer();
    const gate = new ToolGate(server);
    const register = (target: McpServer, name: string) =>
      (target as unknown as { tool: (...a: unknown[]) => unknown }).tool(
        name,
        "",
        {},
        async () => "ok"
      );
    register(gate.wrap(server, "memory"), "search_notes");
    register(gate.wrap(server, "mail", { deferred: true }), "list_messages");
    register(gate.wrap(server, "mail", { deferred: true }), "send_message");
    gate.arm();
    return {
      gate,
      notified,
      visible: () => handles.filter((h) => h.enabled).map((h) => h.name),
    };
  }

  it("leaves a deferred capability hidden when Betty wakes", () => {
    const { gate, visible } = tiered();
    gate.wake();
    expect(visible()).toEqual(["search_notes"]);
  });

  it("reveals it when asked for by name", () => {
    const { gate, visible } = tiered();
    gate.wake();
    expect(gate.openGroup("mail")).toBe("opened");
    expect(visible()).toEqual(["search_notes", "list_messages", "send_message"]);
  });

  it("says so rather than lying when the name is not a capability", () => {
    const { gate } = tiered();
    gate.wake();
    expect(gate.openGroup("telepathy")).toBe("unknown");
  });

  it("neither lists nor opens a capability whose tools were all disabled", () => {
    // `wrap` files the group before the tools register, so a user who put every
    // mail tool in DISABLED_TOOLS leaves an empty one behind. From the model's
    // side that is indistinguishable from mail never having been configured.
    const { server } = stubServer();
    const gate = new ToolGate(server);
    gate.wrap(server, "mail", { deferred: true });
    gate.arm();
    gate.wake();
    expect(gate.inventory).toEqual([]);
    expect(gate.openGroup("mail")).toBe("unknown");
  });

  it("reports a second open as already-open, without a second notification", () => {
    const { gate, notified } = tiered();
    gate.wake();
    gate.openGroup("mail");
    const before = notified.length;
    expect(gate.openGroup("mail")).toBe("already-open");
    expect(notified).toHaveLength(before);
  });

  it("refuses to call a drawer open while Betty is asleep", () => {
    // Unreachable through `open_drawer`, which is gated itself — but the answer
    // has to be honest anyway, because "opened" here would name tools that the
    // client's next `tools/list` does not contain.
    const { gate, visible, notified } = tiered();
    expect(gate.openGroup("mail")).toBe("asleep");
    expect(visible()).toEqual([]);
    expect(notified).toHaveLength(0);
  });

  it("still honours a request made while asleep at the next wake", () => {
    const { gate, visible } = tiered();
    gate.openGroup("mail");
    gate.wake();
    expect(visible()).toContain("list_messages");
  });

  it("brings back a capability that was opened before the gate re-armed", () => {
    // Otherwise an idle stretch mid-conversation would quietly cost the model
    // the capability it had already decided it needed.
    const { gate, visible } = tiered();
    gate.wake();
    gate.openGroup("mail");
    gate.rearm();
    gate.wake();
    expect(visible()).toContain("list_messages");
  });

  it("marks what is open and what is held back", () => {
    const { gate } = tiered();
    gate.wake();
    expect(gate.inventory).toEqual([
      { group: "memory", tools: ["search_notes"], open: true, deferred: false },
      {
        group: "mail",
        tools: ["list_messages", "send_message"],
        open: false,
        deferred: true,
      },
    ]);
  });
});

describe("withdraw()", () => {
  function withMail() {
    const { server, handles, notified } = stubServer();
    const gate = new ToolGate(server);
    (gate.wrap(server, "mail") as unknown as { tool: (...a: unknown[]) => unknown }).tool(
      "list_messages",
      "",
      {},
      async () => "ok"
    );
    (gate.wrap(server, "memory") as unknown as { tool: (...a: unknown[]) => unknown }).tool(
      "search_notes",
      "",
      {},
      async () => "ok"
    );
    return { gate, handles, notified };
  }

  it("takes the capability out of the inventory entirely", () => {
    // Not flagged as broken — absent. A capability a model cannot see is a
    // capability it cannot promise the user.
    const { gate } = withMail();
    expect(gate.withdraw("mail")).toBe(true);
    expect(gate.inventory.map((group) => group.group)).toEqual(["memory"]);
  });

  it("keeps it hidden through a later wake", () => {
    const { gate, handles } = withMail();
    gate.withdraw("mail");
    gate.arm();
    gate.wake();
    expect(handles.find((h) => h.name === "list_messages")?.enabled).toBe(false);
    expect(handles.find((h) => h.name === "search_notes")?.enabled).toBe(true);
  });

  it("cannot be re-opened by name", () => {
    const { gate } = withMail();
    gate.withdraw("mail");
    expect(gate.openGroup("mail")).toBe("unknown");
  });

  it("is idempotent, and says so", () => {
    const { gate } = withMail();
    gate.withdraw("mail");
    expect(gate.withdraw("mail")).toBe(false);
  });
});

describe("arm() and wake()", () => {
  it("starts open — arming is the composition root's decision, not the gate's", () => {
    const { gate, enabledCount } = setup(3);
    expect(gate.awake).toBe(true);
    expect(enabledCount()).toBe(3);
  });

  it("hides every tool when armed", () => {
    const { gate, enabledCount } = setup(3);
    gate.arm();
    expect(gate.awake).toBe(false);
    expect(enabledCount()).toBe(0);
  });

  it("does not notify on the first arm — nobody has asked for a list yet", () => {
    const { gate, notified } = setup(3);
    gate.arm();
    expect(notified).toEqual([]);
  });

  it("restores every tool on wake", () => {
    const { gate, enabledCount } = setup(3);
    gate.arm();
    expect(gate.wake()).toBe(true);
    expect(enabledCount()).toBe(3);
  });

  it("sends exactly one list_changed for the whole batch", () => {
    // One notification per tool would be three round-trips advertising a list
    // that only changed once.
    const { gate, notified } = setup(3);
    gate.arm();
    gate.wake();
    expect(notified).toEqual([3]);
  });

  it("makes a second wake a no-op, so a duplicate call is harmless", () => {
    const { gate, notified } = setup(3);
    gate.arm();
    gate.wake();
    expect(gate.wake()).toBe(false);
    expect(notified).toHaveLength(1);
  });
});

describe("re-arming", () => {
  it("does nothing when no rearm interval is configured", () => {
    const { gate, advance, enabledCount } = setup(3);
    advance(60 * 60_000);
    expect(gate.sweep()).toBe(false);
    expect(enabledCount()).toBe(3);
  });

  it("closes the gate once the idle window passes", () => {
    const { gate, advance, enabledCount } = setup(3, { rearmMs: 10 * 60_000 });
    advance(11 * 60_000);
    expect(gate.sweep()).toBe(true);
    expect(enabledCount()).toBe(0);
  });

  it("leaves it open inside the window", () => {
    const { gate, advance, enabledCount } = setup(3, { rearmMs: 10 * 60_000 });
    advance(9 * 60_000);
    expect(gate.sweep()).toBe(false);
    expect(enabledCount()).toBe(3);
  });

  it("counts a tool call as activity", async () => {
    // The point of the handler wrapper: a conversation actively using Betty
    // must not have her tools pulled out from under it.
    const { gate, advance, callTool, enabledCount } = setup(3, { rearmMs: 10 * 60_000 });
    advance(9 * 60_000);
    await callTool(0);
    advance(9 * 60_000);
    expect(gate.sweep()).toBe(false);
    expect(enabledCount()).toBe(3);
  });

  it("notifies when it re-arms, so the client refetches the short list", () => {
    const { gate, advance, notified } = setup(3, { rearmMs: 10 * 60_000 });
    advance(11 * 60_000);
    gate.sweep();
    expect(notified).toEqual([0]);
  });

  it("does not re-arm a gate that is already shut", () => {
    const { gate, advance, notified } = setup(3, { rearmMs: 10 * 60_000 });
    gate.arm();
    advance(11 * 60_000);
    expect(gate.sweep()).toBe(false);
    expect(notified).toEqual([]);
  });

  it("re-opens on the next wake, and keeps re-arming after that", () => {
    const { gate, advance, enabledCount } = setup(3, { rearmMs: 10 * 60_000 });
    advance(11 * 60_000);
    gate.sweep();
    gate.wake();
    expect(enabledCount()).toBe(3);
    advance(11 * 60_000);
    expect(gate.sweep()).toBe(true);
  });

  it("treats waking as activity, so the window starts from the wake", () => {
    const { gate, advance } = setup(3, { rearmMs: 10 * 60_000 });
    gate.arm();
    advance(11 * 60_000);
    gate.wake();
    advance(9 * 60_000);
    expect(gate.sweep()).toBe(false);
  });
});

describe("startSweeping()", () => {
  it("does not start a timer when re-arming is off", () => {
    const { gate } = setup(1);
    gate.startSweeping();
    // No handle to inspect, but a second call must stay a no-op either way.
    expect(() => gate.stopSweeping()).not.toThrow();
  });

  it("runs the sweep on its interval and can be stopped", () => {
    jest.useFakeTimers();
    try {
      const { gate, advance, enabledCount } = setup(3, { rearmMs: 10 * 60_000 });
      gate.startSweeping();
      advance(11 * 60_000);
      jest.advanceTimersByTime(60_000);
      expect(enabledCount()).toBe(0);
      gate.stopSweeping();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("parseRearmMs()", () => {
  it("defaults to ten minutes", () => {
    expect(parseRearmMs(undefined)).toBe(DEFAULT_REARM_MINUTES * 60_000);
    expect(parseRearmMs("")).toBe(DEFAULT_REARM_MINUTES * 60_000);
  });

  it("reads minutes", () => {
    expect(parseRearmMs("30")).toBe(30 * 60_000);
  });

  it("treats 0 as never re-arming", () => {
    expect(parseRearmMs("0")).toBe(0);
  });

  it("accepts fractions, for anyone who wants a very short window", () => {
    expect(parseRearmMs("0.5")).toBe(30_000);
  });

  it("rejects nonsense rather than silently never re-arming", () => {
    expect(() => parseRearmMs("soon")).toThrow(/BETTY_WAKE_REARM_MINUTES/);
    expect(() => parseRearmMs("-5")).toThrow(/non-negative/);
  });
});
