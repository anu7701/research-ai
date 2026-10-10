import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  simulateStreamingMiddleware,
  wrapLanguageModel,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { fetchPage, searchWeb } from "./research";
import { MODEL } from "./workflow";

export { ResearchWorkflow } from "./workflow";

type Note = {
  id: number;
  topic: string;
  content: string;
  sources: string;
  created_at: string;
};

const SYSTEM_PROMPT = `You are a careful research assistant with persistent memory.

Process for every research question:
1. PLAN: briefly state the 2-3 sub-questions you will investigate.
2. CHECK MEMORY: call listNotes first; reuse earlier findings when relevant.
3. GATHER: call searchWeb, then fetchPage on the most relevant results. Never answer factual questions from your own knowledge alone.
4. CITE: every claim must reference its source URL. If sources disagree or you found nothing, say so plainly.
5. SAVE: call saveNote with a short topic, the key findings, and the source URLs.

Only call startResearch when the user explicitly asks for a deep or background investigation; otherwise research directly with searchWeb/fetchPage. Never call the same tool repeatedly with the same input after it returns an error - explain the problem instead. After startResearch, say the research is running in the background and the user can ask "what's the status?" in plain words (never mention tool or function names to the user). When the run is complete, its report is saved as a note: read it with listNotes and summarize it with citations.

Follow-ups like "compare that with what we found earlier" must use listNotes. Be concise and structured.`;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS research_runs (
      workflow_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT
    )`;
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  /** Public so the research workflow can persist findings via RPC. */
  async saveNote(topic: string, content: string, sources: string[] = []) {
    const src = JSON.stringify(sources);
    this
      .sql`INSERT INTO notes (topic, content, sources) VALUES (${topic}, ${content}, ${src})`;
    return "saved";
  }

  async onWorkflowProgress(_name: string, id: string, progress: unknown) {
    const step = (progress as { step?: string })?.step ?? "running";
    this
      .sql`UPDATE research_runs SET status = ${step} WHERE workflow_id = ${id}`;
  }

  async onWorkflowComplete(_name: string, id: string) {
    this
      .sql`UPDATE research_runs SET status = 'complete' WHERE workflow_id = ${id}`;
  }

  async onWorkflowError(_name: string, id: string, error: string) {
    this
      .sql`UPDATE research_runs SET status = 'error', detail = ${error} WHERE workflow_id = ${id}`;
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Llama over-eagerly picks the background workflow; only offer it when the
    // user actually asks for a deep/background run or its status.
    const lastUser = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastText = (lastUser?.parts ?? [])
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ");
    const wantsWorkflow =
      /deep|in-depth|in depth|background|workflow|status/i.test(lastText);

    const result = streamText({
      // Llama 3.3 on Workers AI emits corrupted (duplicated) tool-call
      // arguments when streamed, so generate each step whole and replay it
      // as a stream.
      model: wrapLanguageModel({
        model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
        middleware: simulateStreamingMiddleware()
      }),
      system: `${SYSTEM_PROMPT}

${getSchedulePrompt({ date: new Date() })}`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        searchWeb: tool({
          description:
            "Search the web. Returns titles, URLs and snippets. Follow up with fetchPage to read a result.",
          inputSchema: z.object({
            query: z.string().describe("Search query")
          }),
          execute: async ({ query }) => {
            try {
              return await searchWeb(query, 5);
            } catch (e) {
              return { error: String(e) };
            }
          }
        }),

        fetchPage: tool({
          description:
            "Fetch a web page by URL and return its readable text (truncated).",
          inputSchema: z.object({
            url: z.string().url().describe("Absolute http(s) URL")
          }),
          execute: async ({ url }) => {
            try {
              return await fetchPage(url, 6000);
            } catch (e) {
              return { error: String(e) };
            }
          }
        }),

        saveNote: tool({
          description:
            "Save research findings to long-term memory so they can be recalled in later conversations.",
          inputSchema: z.object({
            topic: z.string().describe("Short topic label"),
            content: z.string().describe("Key findings, concise"),
            sources: z.array(z.string()).describe("Source URLs")
          }),
          execute: async ({ topic, content, sources }) => {
            await this.saveNote(topic, content, sources);
            return { saved: true, topic };
          }
        }),

        listNotes: tool({
          description:
            "List saved research notes (most recent first). Optionally filter by a keyword.",
          inputSchema: z.object({
            keyword: z.string().optional().describe("Filter by keyword")
          }),
          execute: async ({ keyword }) => {
            const all = this
              .sql<Note>`SELECT id, topic, content, sources, created_at FROM notes
              ORDER BY id DESC LIMIT 50`;
            if (!all.length) return "No notes saved yet.";
            // Normalise so "nodejs" matches "Node.js" / "Node JS".
            const norm = (t: string) =>
              t.toLowerCase().replace(/[^a-z0-9]+/g, "");
            const words = (keyword ?? "")
              .split(/\s+/)
              .map(norm)
              .filter(Boolean);
            if (!words.length) return all.slice(0, 20);
            const hits = all.filter((n) => {
              const hay = norm(`${n.topic} ${n.content}`);
              return words.some((w) => hay.includes(w));
            });
            // Never hide saved notes behind a filter miss.
            return hits.length
              ? hits.slice(0, 20)
              : {
                  note: `No notes matched "${keyword}"; showing all saved notes.`,
                  notes: all.slice(0, 20).map((n) => ({
                    id: n.id,
                    topic: n.topic,
                    created_at: n.created_at
                  }))
                };
          }
        }),

        startResearch: tool({
          description:
            "Start a durable background research workflow (plan, fetch, summarize, save) for an in-depth question.",
          inputSchema: z.object({
            question: z.string().describe("The research question")
          }),
          execute: async ({ question }) => {
            const id = await this.runWorkflow("RESEARCH_WORKFLOW", {
              question
            });
            this
              .sql`INSERT INTO research_runs (workflow_id, question, status) VALUES (${id}, ${question}, 'started')`;
            return { workflowId: id, status: "started" };
          }
        }),

        getResearchStatus: tool({
          description:
            "Check background research runs. When complete, the report is saved as a note; read it with listNotes.",
          inputSchema: z.object({}),
          execute: async () => {
            const rows = this
              .sql`SELECT workflow_id, question, status, detail FROM research_runs ORDER BY rowid DESC LIMIT 5`;
            return rows.length ? rows : "No research runs yet.";
          }
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      activeTools: [
        ...(Object.keys(mcpTools) as string[]),
        "searchWeb",
        "fetchPage",
        "saveNote",
        "listNotes",
        "getUserTimezone",
        "calculate",
        "scheduleTask",
        "getScheduledTasks",
        "cancelScheduledTask",
        ...(wantsWorkflow ? ["startResearch", "getResearchStatus"] : [])
      ] as never,
      stopWhen: stepCountIs(15),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
