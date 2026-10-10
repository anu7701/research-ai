import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { ChatAgent } from "./server";
import { fetchPage, searchWeb } from "./research";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type ResearchParams = { question: string };
type Source = { url: string; title: string; text: string };

/**
 * Durable multi-step research: plan -> search/fetch -> summarize -> save.
 * Each step is retried and checkpointed independently by Workflows.
 */
export class ResearchWorkflow extends AgentWorkflow<ChatAgent, ResearchParams> {
  private async llm(system: string, user: string): Promise<string> {
    const out = (await this.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: 1024
    })) as { response?: string };
    return out.response ?? "";
  }

  async run(
    event: AgentWorkflowEvent<ResearchParams>,
    step: AgentWorkflowStep
  ) {
    const { question } = event.payload;

    await this.reportProgress({ step: "plan", status: "running" });
    const queries = await step.do("plan", async () => {
      const raw = await this.llm(
        'Break the research question into 2-3 distinct web search queries. Reply with ONLY a JSON array of strings, e.g. ["query one","query two"].',
        question
      );
      try {
        const parsed = JSON.parse(/\[[\s\S]*\]/.exec(raw)?.[0] ?? "[]");
        const qs = (parsed as unknown[])
          .filter((q): q is string => typeof q === "string")
          .slice(0, 3);
        if (qs.length) return qs;
      } catch {
        // fall through to default
      }
      return [question];
    });

    await this.reportProgress({ step: "fetch", status: "running" });
    const sources = await step.do(
      "fetch",
      { retries: { limit: 2, delay: "2 seconds" } },
      async () => {
        const seen = new Set<string>();
        const out: Source[] = [];
        for (const q of queries) {
          const results = await searchWeb(q, 3).catch(() => []);
          for (const r of results) {
            if (seen.has(r.url) || out.length >= 5) continue;
            seen.add(r.url);
            try {
              const p = await fetchPage(r.url, 3000);
              if (p.text.length > 200) {
                out.push({
                  url: p.url,
                  title: p.title || r.title,
                  text: p.text
                });
              }
            } catch {
              // skip unreachable pages
            }
          }
        }
        if (!out.length) throw new Error("No pages could be fetched");
        return out;
      }
    );

    await this.reportProgress({ step: "summarize", status: "running" });
    const report = await step.do("summarize", async () => {
      const material = sources
        .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.text}`)
        .join("\n\n");
      return this.llm(
        "You are a research analyst. Using ONLY the numbered sources, write a concise findings summary (bullet points) answering the question. Cite sources inline like [1]. Do not invent facts.",
        `Question: ${question}\n\nSources:\n${material}`
      );
    });

    const finalReport = `${report}\n\nSources:\n${sources
      .map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`)
      .join("\n")}`;

    await step.do("save", async () => {
      await this.agent.saveNote(
        question,
        finalReport,
        sources.map((s) => s.url)
      );
    });

    const result = { question, report: finalReport };
    await step.reportComplete(result);
    return result;
  }
}
