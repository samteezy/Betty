import { registerCalendarTools, CalendarToolConfig } from "./calendar";
import { harness } from "../test-support/mcp";
import { FakeCalendarBackend, makeEvent } from "../test-support/backends";
import { withEnv } from "../test-support/env";
import { ListEventsOptions, SearchEventsOptions } from "../types";

function setup(config: CalendarToolConfig = {}) {
  const backend = new FakeCalendarBackend();
  const h = harness((server) => registerCalendarTools(server, backend, config));
  return { backend, ...h };
}

describe("registration", () => {
  it("registers all four calendar tools", () => {
    expect(setup().names()).toEqual([
      "get_event",
      "list_calendars",
      "list_events",
      "search_events",
    ]);
  });

  it("honours DISABLED_TOOLS", () => {
    const { tools } = withEnv(
      { DISABLED_TOOLS: "search_events, list_calendars" },
      () => setup()
    );

    expect(tools.has("search_events")).toBe(false);
    expect(tools.has("list_calendars")).toBe(false);
    expect(tools.has("list_events")).toBe(true);
    expect(tools.has("get_event")).toBe(true);
  });
});

describe("list_calendars", () => {
  it("returns the backend's calendars unprojected", async () => {
    const { backend, json } = setup();
    backend.calendars = [
      {
        href: "/calendars/personal/",
        name: "Personal",
        color: "#FF0000",
        description: "My calendar",
      },
    ];

    const calendars = await json("list_calendars");

    expect(calendars).toEqual([
      {
        href: "/calendars/personal/",
        name: "Personal",
        color: "#FF0000",
        description: "My calendar",
      },
    ]);
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("CalDAV unreachable");

    const result = await call("list_calendars");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: CalDAV unreachable");
  });
});

describe("list_events", () => {
  it("forwards calendar and limit to the backend", async () => {
    const { backend, json } = setup();
    await json("list_events", { calendar: "Work", limit: 10 });

    expect(backend.lastCall<ListEventsOptions>("listEvents")).toEqual({
      calendar: "Work",
      limit: 10,
    });
  });

  it("projects lean fields by default", async () => {
    const { backend, json } = setup();
    backend.events = [
      makeEvent({
        id: "e1",
        href: "/calendars/e1.ics",
        title: "Team Standup",
        location: "Zoom",
        description: "Daily sync",
        organizer: "alice@example.com",
        attendees: ["bob@example.com"],
        status: "CONFIRMED",
      }),
    ];

    const [event] = await json("list_events");

    expect(event).toEqual({
      id: "e1",
      href: "/calendars/e1.ics",
      title: "Team Standup",
      start: "2026-08-17T09:00:00Z",
      end: "2026-08-17T09:30:00Z",
      allDay: false,
      calendar: "Personal",
      location: "Zoom",
    });
    expect(event.description).toBeUndefined();
    expect(event.attendees).toBeUndefined();
  });

  it("omits location when absent", async () => {
    const { backend, json } = setup();
    backend.events = [makeEvent({ id: "e1" })];

    const [event] = await json("list_events");

    expect("location" in event).toBe(false);
  });

  it("keeps allDay even when false", async () => {
    // allDay is an always-key, so a false value must survive the projection —
    // dropping it would read as "unknown" rather than "timed event".
    const { backend, json } = setup();
    backend.events = [makeEvent({ id: "e1", allDay: false })];

    const [event] = await json("list_events");

    expect(event.allDay).toBe(false);
  });

  it("returns every field when verbose", async () => {
    const { backend, json } = setup();
    backend.events = [
      makeEvent({ id: "e1", description: "Daily sync", status: "CONFIRMED" }),
    ];

    const [event] = await json("list_events", { verbose: true });

    expect(event.description).toBe("Daily sync");
    expect(event.status).toBe("CONFIRMED");
  });

  it("includes calendar only when no calendar filter applies", async () => {
    const { backend, json } = setup();
    backend.events = [makeEvent({ id: "e1" })];

    const [unfiltered] = await json("list_events");
    expect(unfiltered.calendar).toBe("Personal");

    const [filtered] = await json("list_events", { calendar: "Work" });
    expect(filtered.calendar).toBeUndefined();
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("CalDAV unreachable");

    const result = await call("list_events");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: CalDAV unreachable");
  });
});

describe("default calendar", () => {
  it("applies the configured default when the call omits one", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    await json("list_events");

    expect(backend.lastCall<ListEventsOptions>("listEvents").calendar).toBe("Work");
  });

  it("lets an explicit calendar win over the default", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    await json("list_events", { calendar: "Personal" });

    expect(backend.lastCall<ListEventsOptions>("listEvents").calendar).toBe(
      "Personal"
    );
  });

  it("applies to search_events too", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    await json("search_events", { query: "standup" });

    expect(backend.lastCall<SearchEventsOptions>("searchEvents").calendar).toBe(
      "Work"
    );
  });

  it("suppresses the calendar column once a default is configured", async () => {
    const { backend, json } = setup({ defaultCalendar: "Work" });
    backend.events = [makeEvent({ id: "e1" })];

    const [event] = await json("list_events");
    expect(event.calendar).toBeUndefined();
  });
});

describe("get_event", () => {
  it("returns the event when found", async () => {
    const { backend, json } = setup();
    backend.events = [
      makeEvent({ id: "e1", href: "/calendars/e1.ics", title: "Team Standup" }),
    ];

    const event = await json("get_event", { href: "/calendars/e1.ics" });

    expect(event.title).toBe("Team Standup");
  });

  it("reports a missing event as an error", async () => {
    const { call } = setup();

    const result = await call("get_event", { href: "/calendars/nope.ics" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Event not found");
  });

  it("returns the full event, not the lean projection", async () => {
    const { backend, json } = setup();
    backend.events = [
      makeEvent({ id: "e1", href: "/calendars/e1.ics", description: "Daily sync" }),
    ];

    const event = await json("get_event", { href: "/calendars/e1.ics" });

    expect(event.description).toBe("Daily sync");
  });
});

describe("search_events", () => {
  it("forwards the query, calendar and limit", async () => {
    const { backend, json } = setup();
    await json("search_events", { query: "standup", calendar: "Work", limit: 5 });

    expect(backend.lastCall<SearchEventsOptions>("searchEvents")).toEqual({
      query: "standup",
      calendar: "Work",
      limit: 5,
    });
  });

  it("projects lean fields by default and everything when verbose", async () => {
    const { backend, json } = setup();
    backend.events = [makeEvent({ id: "e1", description: "Daily sync" })];

    const [lean] = await json("search_events", { query: "standup" });
    expect(lean.description).toBeUndefined();

    const [verbose] = await json("search_events", {
      query: "standup",
      verbose: true,
    });
    expect(verbose.description).toBe("Daily sync");
  });

  it("surfaces backend failures as tool errors", async () => {
    const { backend, call } = setup();
    backend.failWith = new Error("search index offline");

    const result = await call("search_events", { query: "standup" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: search index offline");
  });
});
