# Research Assistant (Cloudflare Agents)

An AI research agent on Cloudflare Workers. Ask a question; it plans, searches the web, reads real pages, cites sources, and saves findings to memory that persists across sessions.

## Architecture

```
Chat UI -> ChatAgent (Llama 3.3 70B, Workers AI)
             tools: searchWeb / fetchPage / saveNote / listNotes
                    startResearch / getResearchStatus
             SQLite (Durable Object): notes, research_runs
             ResearchWorkflow: plan -> fetch -> summarize -> save
```

- **LLM:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI
- **Agent:** `ChatAgent` in `src/server.ts` (Agents SDK `AIChatAgent`)
- **Memory:** `notes` table in the agent's SQLite; follow-ups like "compare that with what we found earlier" use `listNotes`
- **Web tools:** `src/research.ts` (keyless DuckDuckGo HTML search, page fetch with text extraction and a private-address guard)
- **Workflow:** `src/workflow.ts` - durable, retried steps; saves its report as a note when done
- **UI:** the starter's React chat UI (`src/app.tsx`)

## Run locally

```bash
npm install
npm run dev
```

Workers AI is called remotely (`"remote": true`), so you need `wrangler login`.

## Deploy

```bash
npm run deploy
```

## Notes / limitations

- Search scrapes DuckDuckGo's HTML endpoint; swap `searchWeb` for a search API (Brave, Tavily) for production use.
- Page text is truncated to keep the context small; JS-rendered pages return little text.
- Prompts are documented in `PROMPTS.md`.
