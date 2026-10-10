# PROMPTS.md

A record of the prompts that shaped this project: the prompts I gave the AI coding assistant, the runtime prompts the agent uses, and how real failures changed them.

## 1. Building prompts (to the coding assistant)

| # | Intent | Prompt (summarised) |
|---|--------|---------------------|
| 1 | Scaffold | "Build a research assistant on Cloudflare Agents. Llama 3.3, the starter's chat UI, tools `searchWeb` / `fetchPage` / `saveNote` / `listNotes`, notes in the agent's SQLite, and a Workflow for plan -> fetch -> summarize." |
| 2 | Debug | Pasted a screenshot of seven failing `startResearch` calls ("An error occurred.") and asked why. |
| 3 | Debug | Pasted the raw message JSON showing a corrupted tool input and asked what was wrong. |
| 4 | Debug | Pasted a screenshot of `listNotes` returning "No notes saved yet." after Node.js had been researched and saved. |

Prompts 2 to 4 were useful because they included evidence (screenshot or raw payload). The raw payload in #3 is what exposed the real cause.

## 2. Runtime prompts (what the deployed agent sees)

### 2.1 Agent system prompt (`SYSTEM_PROMPT` in `src/server.ts`)

Current version:

```
You are a careful research assistant with persistent memory.

Process for every research question:
1. PLAN: briefly state the 2-3 sub-questions you will investigate.
2. CHECK MEMORY: call listNotes first; reuse earlier findings when relevant.
3. GATHER: call searchWeb, then fetchPage on the most relevant results.
   Never answer factual questions from your own knowledge alone.
4. CITE: every claim must reference its source URL. If sources disagree or
   you found nothing, say so plainly.
5. SAVE: call saveNote with a short topic, the key findings, and the source URLs.

Only call startResearch when the user explicitly asks for a deep or background
investigation; otherwise research directly with searchWeb/fetchPage. Never call
the same tool repeatedly with the same input after it returns an error -
explain the problem instead. After startResearch, say the research is running
in the background and the user can ask "what's the status?" in plain words
(never mention tool or function names to the user). When the run is complete,
its report is saved as a note: read it with listNotes and summarize it with
citations.

Follow-ups like "compare that with what we found earlier" must use listNotes.
Be concise and structured.
```

Design intent: a fixed procedure (plan, memory, gather, cite, save) so behaviour is predictable on a mid-size model, with grounding rules ("never answer from your own knowledge", "cite every claim") to limit hallucination.

### 2.2 Workflow prompts (`src/workflow.ts`)

- **Plan:** "Break the research question into 2-3 distinct web search queries. Reply with ONLY a JSON array of strings, e.g. ["query one","query two"]." The output is parsed defensively; on any failure the original question becomes the single query.
- **Summarize:** "You are a research analyst. Using ONLY the numbered sources, write a concise findings summary (bullet points) answering the question. Cite sources inline like [1]. Do not invent facts."

## 3. How the hard bugs were solved

### 3.1 Tool calls failing with "An error occurred." (the big one)

- **Symptom:** `startResearch` failed 7 to 16 times in a row. The UI only said "An error occurred."
- **Wrong first theory:** the tool or the workflow binding was throwing. Fixing that (explicit `agentBinding`, returning errors as data) was needed but did not cure the symptom.
- **Evidence that changed the diagnosis:** the raw tool input in the message JSON was `{"question": "{"question": "CloudCloudflareflare D Durableurable Objects Objects vs vs KV"} KV"}`. The model's arguments were corrupted before my code ever ran.
- **Root cause:** Llama 3.3 on Workers AI duplicates tokens when tool-call arguments are *streamed*. The AI SDK received invalid JSON, rejected the call at input validation, and the model retried the same broken call.
- **Fix:** generate each model step whole and replay it as a stream (`wrapLanguageModel` with `simulateStreamingMiddleware`). Tool arguments became clean. Trade-off: text arrives in one chunk instead of token by token.
- **Lesson:** when a tool fails with a generic error, inspect the *raw tool input*, not just the tool's code.

### 3.2 Model over-eagerly picking the background workflow

- **Symptom:** a plain "research X and save it" request triggered `startResearch`, and the model looped on it.
- **What did not work:** telling it in the prompt to use the workflow "only when explicitly asked". Llama ignored the instruction.
- **Fix:** enforce it in code. `startResearch` and `getResearchStatus` are only included in `activeTools` when the user's message mentions deep, in-depth, background, workflow or status.
- **Lesson:** for a mid-size model, a constraint that matters should be enforced by tool availability, not by prose.

### 3.3 Workflow could not be started

- **Symptom:** `runWorkflow` failed when the agent binding name was inferred.
- **Fix:** pass `{ agentBinding: "ChatAgent" }` explicitly. Reproduced and verified against the dev server with a temporary debug route (removed afterwards).

### 3.4 Workflow status stuck at "summarize"

- **Cause:** the workflow saved its note but never reported completion.
- **Fix:** call `step.reportComplete(result)` at the end of `run()` so `onWorkflowComplete` fires and the run is marked complete.

### 3.5 Web search silently returning nothing

- **Symptom:** `searchWeb` returned `[]` inside the Worker although it worked from a laptop.
- **Cause:** DuckDuckGo answered the Worker's request with a 202 bot-challenge page, which my parser read as "zero results".
- **Fix:** try DuckDuckGo, fall back to Bing, and throw a clear error when both fail so the model can tell the user instead of inventing an answer.

### 3.6 `listNotes` reporting "No notes saved yet." when notes existed

- **Cause:** a literal `LIKE '%nodejs%'` filter. A note titled "Node.js" does not contain `nodejs`, and the empty result reused the "no notes saved" message, which hid the real cause.
- **Fix:** normalise both sides (lower-case, strip punctuation and spaces), match on any keyword, and when nothing matches return the saved topics with an explicit "no match" note. "No notes saved yet." now appears only when the table is truly empty.
- **Lesson:** an empty-result message should say *why* it is empty.

### 3.7 UX polish

- The assistant told users to "use the getResearchStatus function". The prompt now forbids mentioning tool names and says to ask "what's the status?" in plain words.
- The raw JSON block above tool cards is the starter UI's Debug toggle, not application output.

## 4. Verification approach

Each fix was checked by driving the real chat endpoint over its WebSocket protocol on the dev server (real Workers AI and real web fetches), not only by type-checking. Examples: save a "Node.js event loop" note, then ask "what did we research about nodejs" in the same room and confirm `listNotes` returns it with sources.

## 5. Known limitations

- Search is scraped, keyless and best-effort. Swap `searchWeb` for a search API (Brave, Tavily) for production.
- Llama may still attempt a tool it was not offered; the SDK reports the error and the model recovers.
- Text responses are no longer token-streamed (see 3.1).
- The app has no authentication; anyone with the URL can spend the Workers AI quota.
