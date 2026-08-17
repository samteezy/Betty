import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TaskBackend, TaskInfo } from "../types.js";
import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toLean,
  toolEnabled,
} from "./helpers.js";

function toLeanTasks(
  tasks: TaskInfo[],
  opts: { includeCalendar: boolean }
) {
  const always: (keyof TaskInfo)[] = ["id", "href", "title"];
  if (opts.includeCalendar) always.push("calendar");
  return toLean(tasks, always, ["status", "due", "priority"]);
}

/**
 * Config is passed in rather than read from process.env here, so tool handlers
 * stay free of transport and environment concerns.
 */
export interface TaskToolConfig {
  /** Calendar used when a tool call omits one. */
  defaultCalendar?: string;
}

export function registerTaskTools(
  server: McpServer,
  backend: TaskBackend,
  config: TaskToolConfig = {}
): void {
  const disabled = parseDisabledTools();
  const defaultCalendar = config.defaultCalendar;

  if (toolEnabled("list_tasks", disabled)) {
    server.tool(
      "list_tasks",
      "List tasks/todos",
      {
        calendar: z
          .string()
          .optional()
          .describe("Calendar name to filter by"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max tasks to return (default 50)"),
        status: z
          .string()
          .optional()
          .describe("Filter by status: NEEDS-ACTION, IN-PROCESS, COMPLETED, or CANCELLED"),
        includeCompleted: z
          .boolean()
          .optional()
          .describe("Include completed/cancelled tasks (default false)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields (description, categories, start, completed, percentComplete, recurrence) — default returns only id, href, title, status, due, priority, calendar"
          ),
      },
      async ({ calendar, limit, status, includeCompleted, verbose }) => {
        try {
          const cal = calendar ?? defaultCalendar;
          const tasks = await backend.listTasks({ calendar: cal, limit, status, includeCompleted });
          if (verbose) return jsonResult(tasks);
          return jsonResult(toLeanTasks(tasks, { includeCalendar: !cal }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("get_task", disabled)) {
    server.tool(
      "get_task",
      "Get a single task by href",
      {
        href: z
          .string()
          .describe("The task href (from list_tasks or search_tasks)"),
      },
      async ({ href }) => {
        try {
          const task = await backend.getTask(href);
          if (!task) {
            return {
              content: [{ type: "text" as const, text: "Task not found" }],
              isError: true,
            };
          }
          return jsonResult(task);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("search_tasks", disabled)) {
    server.tool(
      "search_tasks",
      "Search tasks by text query",
      {
        query: z.string().describe("Search text (matches title, description, categories)"),
        calendar: z.string().optional().describe("Calendar name to search within"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results (default 50)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields — default returns only id, href, title, status, due, priority, calendar"
          ),
      },
      async ({ query, calendar, limit, verbose }) => {
        try {
          const cal = calendar ?? defaultCalendar;
          const tasks = await backend.searchTasks({ query, calendar: cal, limit });
          if (verbose) return jsonResult(tasks);
          return jsonResult(toLeanTasks(tasks, { includeCalendar: !cal }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("create_task", disabled)) {
    server.tool(
      "create_task",
      "Create a new task",
      {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        due: z.string().optional().describe("Due date/time in ISO 8601 format"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe("Priority: 0=undefined, 1=highest, 9=lowest"),
        categories: z
          .array(z.string())
          .optional()
          .describe("Category tags"),
        status: z
          .string()
          .optional()
          .describe("Initial status (default NEEDS-ACTION)"),
        calendar: z
          .string()
          .optional()
          .describe("Target calendar name (uses first task-capable calendar if omitted)"),
      },
      async ({ title, description, due, priority, categories, status, calendar }) => {
        try {
          const cal = calendar ?? defaultCalendar;
          const task = await backend.createTask({
            title,
            description,
            due,
            priority,
            categories,
            status,
            calendar: cal,
          });
          return jsonResult(task);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("update_task", disabled)) {
    server.tool(
      "update_task",
      "Update an existing task",
      {
        href: z.string().describe("The task href"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        due: z.string().optional().describe("New due date/time in ISO 8601"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe("New priority (0-9)"),
        status: z
          .string()
          .optional()
          .describe("New status: NEEDS-ACTION, IN-PROCESS, COMPLETED, or CANCELLED"),
        percentComplete: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Percentage complete (0-100)"),
        categories: z
          .array(z.string())
          .optional()
          .describe("New category tags"),
      },
      async ({ href, title, description, due, priority, status, percentComplete, categories }) => {
        try {
          const task = await backend.updateTask({
            href,
            title,
            description,
            due,
            priority,
            status,
            percentComplete,
            categories,
          });
          return jsonResult(task);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("complete_task", disabled)) {
    server.tool(
      "complete_task",
      "Mark a task as completed",
      {
        href: z.string().describe("The task href"),
      },
      async ({ href }) => {
        try {
          const task = await backend.completeTask(href);
          return jsonResult(task);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
