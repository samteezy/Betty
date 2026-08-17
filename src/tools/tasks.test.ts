import { registerTaskTools, TaskToolConfig } from "./tasks";
import { harness } from "../test-support/mcp";
import { FakeTaskBackend, makeTask } from "../test-support/backends";
import { withEnv } from "../test-support/env";
import { ListTasksOptions, SearchTasksOptions } from "../types";

function setup(config: TaskToolConfig = {}) {
  const backend = new FakeTaskBackend();
  const h = harness((server) => registerTaskTools(server, backend, config));
  return { backend, ...h };
}

describe("registration", () => {
  it("registers all six task tools", () => {
    expect(setup().names()).toEqual([
      "complete_task",
      "create_task",
      "get_task",
      "list_tasks",
      "search_tasks",
      "update_task",
    ]);
  });

  it("honours DISABLED_TOOLS", () => {
    const { tools } = withEnv(
      { DISABLED_TOOLS: "create_task, complete_task" },
      () => setup()
    );

    expect(tools.has("create_task")).toBe(false);
    expect(tools.has("complete_task")).toBe(false);
    expect(tools.has("list_tasks")).toBe(true);
    expect(tools.has("update_task")).toBe(true);
  });

  it("matches DISABLED_TOOLS case-insensitively", () => {
    const { tools } = withEnv({ DISABLED_TOOLS: "List_Tasks" }, () => setup());
    expect(tools.has("list_tasks")).toBe(false);
  });
});

describe("list_tasks", () => {
  it("forwards filters to the backend verbatim", async () => {
    const { backend, json } = setup();
    await json("list_tasks", {
      calendar: "Work",
      limit: 10,
      status: "IN-PROCESS",
      includeCompleted: true,
    });

    expect(backend.lastCall<ListTasksOptions>("listTasks")).toEqual({
      calendar: "Work",
      limit: 10,
      status: "IN-PROCESS",
      includeCompleted: true,
    });
  });

  it("leaves includeCompleted undefined when omitted", async () => {
    // Regression guard for 92944ce: completed/cancelled tasks are excluded by
    // default. The filtering lives in the CalDAV backend, so what this layer
    // owes it is an un-defaulted passthrough.
    const { backend, json } = setup();
    await json("list_tasks", {});

    const options = backend.lastCall<ListTasksOptions>("listTasks");
    expect(options.includeCompleted).toBeUndefined();
    expect("includeCompleted" in options).toBe(true);
  });

  it("projects lean fields by default", async () => {
    const { backend, json } = setup();
    backend.tasks = [
      makeTask({
        id: "t1",
        href: "/tasks/t1.ics",
        title: "Buy milk",
        status: "NEEDS-ACTION",
        due: "2026-08-20T00:00:00Z",
        priority: 5,
        description: "Semi-skimmed",
        categories: ["errands"],
      }),
    ];

    const [task] = await json("list_tasks");

    expect(task).toEqual({
      id: "t1",
      href: "/tasks/t1.ics",
      title: "Buy milk",
      calendar: "Personal",
      status: "NEEDS-ACTION",
      due: "2026-08-20T00:00:00Z",
      priority: 5,
    });
    expect(task.description).toBeUndefined();
    expect(task.categories).toBeUndefined();
  });

  it("omits optional fields that are absent", async () => {
    const { backend, json } = setup();
    backend.tasks = [
      makeTask({ id: "t1", title: "Bare", status: undefined }),
    ];

    const [task] = await json("list_tasks");

    expect(task).toEqual({
      id: "t1",
      href: "/tasks/t1.ics",
      title: "Bare",
      calendar: "Personal",
    });
  });

  it("returns every field when verbose", async () => {
    const { backend, json } = setup();
    backend.tasks = [
      makeTask({ id: "t1", description: "Semi-skimmed", categories: ["errands"] }),
    ];

    const [task] = await json("list_tasks", { verbose: true });

    expect(task.description).toBe("Semi-skimmed");
    expect(task.categories).toEqual(["errands"]);
  });

  it("includes calendar only when no calendar filter applies", async () => {
    const { backend, json } = setup();
    backend.tasks = [makeTask({ id: "t1" })];

    const [unfiltered] = await json("list_tasks");
    expect(unfiltered.calendar).toBe("Personal");

    // Filtered to one calendar, repeating it on every row is dead context.
    const [filtered] = await json("list_tasks", { calendar: "Work" });
    expect(filtered.calendar).toBeUndefined();
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("CalDAV unreachable");

    const result = await call("list_tasks");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: CalDAV unreachable");
  });
});

describe("default calendar", () => {
  it("applies the configured default when the call omits one", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    await json("list_tasks");

    expect(backend.lastCall<ListTasksOptions>("listTasks").calendar).toBe("Work");
  });

  it("lets an explicit calendar win over the default", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    await json("list_tasks", { calendar: "Personal" });

    expect(backend.lastCall<ListTasksOptions>("listTasks").calendar).toBe(
      "Personal"
    );
  });

  it("suppresses the calendar column once a default is configured", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    backend.tasks = [makeTask({ id: "t1" })];

    const [task] = await json("list_tasks");
    expect(task.calendar).toBeUndefined();
  });

  it("applies to search_tasks and create_task too", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });

    await json("search_tasks", { query: "milk" });
    expect(backend.lastCall<SearchTasksOptions>("searchTasks").calendar).toBe(
      "Work"
    );

    await json("create_task", { title: "New" });
    expect(backend.lastCall<{ calendar?: string }>("createTask").calendar).toBe(
      "Work"
    );
  });
});

describe("get_task", () => {
  it("returns the task when found", async () => {
    const { backend, json } = setup();
    backend.tasks = [makeTask({ id: "t1", href: "/tasks/t1.ics", title: "Buy milk" })];

    const task = await json("get_task", { href: "/tasks/t1.ics" });

    expect(task.title).toBe("Buy milk");
  });

  it("reports a missing task as an error", async () => {
    const { call } = setup();

    const result = await call("get_task", { href: "/tasks/nope.ics" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Task not found");
  });

  it("returns the full task, not the lean projection", async () => {
    const { backend, json } = setup();
    backend.tasks = [
      makeTask({ id: "t1", href: "/tasks/t1.ics", description: "Semi-skimmed" }),
    ];

    const task = await json("get_task", { href: "/tasks/t1.ics" });

    expect(task.description).toBe("Semi-skimmed");
  });
});

describe("search_tasks", () => {
  it("forwards the query and limit", async () => {
    const { backend, json } = setup();
    await json("search_tasks", { query: "milk", limit: 5 });

    expect(backend.lastCall<SearchTasksOptions>("searchTasks")).toEqual({
      query: "milk",
      calendar: undefined,
      limit: 5,
    });
  });

  it("projects lean fields by default and everything when verbose", async () => {
    const { backend, json } = setup();
    backend.tasks = [makeTask({ id: "t1", description: "Semi-skimmed" })];

    const [lean] = await json("search_tasks", { query: "milk" });
    expect(lean.description).toBeUndefined();

    const [verbose] = await json("search_tasks", { query: "milk", verbose: true });
    expect(verbose.description).toBe("Semi-skimmed");
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("search index offline");

    const result = await call("search_tasks", { query: "milk" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: search index offline");
  });
});

describe("create_task", () => {
  it("forwards every supported field", async () => {
    const { backend, json } = setup();
    await json("create_task", {
      title: "Buy milk",
      description: "Semi-skimmed",
      due: "2026-08-20T00:00:00Z",
      priority: 3,
      categories: ["errands"],
      status: "IN-PROCESS",
      calendar: "Work",
    });

    expect(backend.lastCall("createTask")).toEqual({
      title: "Buy milk",
      description: "Semi-skimmed",
      due: "2026-08-20T00:00:00Z",
      priority: 3,
      categories: ["errands"],
      status: "IN-PROCESS",
      calendar: "Work",
    });
  });

  it("returns the created task unprojected", async () => {
    const { json } = setup();

    const task = await json("create_task", {
      title: "Buy milk",
      description: "Semi-skimmed",
    });

    expect(task.title).toBe("Buy milk");
    expect(task.description).toBe("Semi-skimmed");
    expect(task.href).toBeDefined();
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("calendar is read-only");

    const result = await call("create_task", { title: "Buy milk" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: calendar is read-only");
  });
});

describe("update_task", () => {
  it("forwards the href and every changed field", async () => {
    const { backend, json } = setup();
    await json("update_task", {
      href: "/tasks/t1.ics",
      title: "Buy oat milk",
      status: "IN-PROCESS",
      percentComplete: 50,
    });

    expect(backend.lastCall("updateTask")).toEqual({
      href: "/tasks/t1.ics",
      title: "Buy oat milk",
      description: undefined,
      due: undefined,
      priority: undefined,
      status: "IN-PROCESS",
      percentComplete: 50,
      categories: undefined,
    });
  });

  it("returns the updated task", async () => {
    const { backend, json } = setup();
    backend.tasks = [makeTask({ id: "t1", href: "/tasks/t1.ics", title: "Old" })];

    const task = await json("update_task", {
      href: "/tasks/t1.ics",
      title: "New",
    });

    expect(task.title).toBe("New");
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("etag conflict");

    const result = await call("update_task", { href: "/tasks/t1.ics" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: etag conflict");
  });
});

describe("complete_task", () => {
  it("forwards the href", async () => {
    const { backend, json } = setup();
    await json("complete_task", { href: "/tasks/t1.ics" });

    expect(backend.lastCall("completeTask")).toBe("/tasks/t1.ics");
  });

  it("returns the completed task", async () => {
    const { backend, json } = setup();
    backend.tasks = [makeTask({ id: "t1", href: "/tasks/t1.ics" })];

    const task = await json("complete_task", { href: "/tasks/t1.ics" });

    expect(task.status).toBe("COMPLETED");
    expect(task.percentComplete).toBe(100);
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("task not found");

    const result = await call("complete_task", { href: "/tasks/t1.ics" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: task not found");
  });
});
