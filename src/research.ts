// Shared web helpers used by both the chat agent's tools and the research workflow.

const UA = "Mozilla/5.0 (compatible; ResearchAssistant/1.0)";

export type SearchResult = { title: string; url: string; snippet: string };

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string) {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Only allow public http(s) URLs (basic SSRF guard). */
export function assertSafeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const h = url.hostname;
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    /^(127|10)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "[::1]"
  ) {
    throw new Error("Private addresses are not allowed");
  }
  return url;
}

export async function fetchPage(rawUrl: string, maxChars = 6000) {
  const url = assertSafeUrl(rawUrl);
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,text/plain,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const body = (await res.text()).slice(0, 1_000_000);
  const title = stripTags(
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? ""
  );
  const text = stripTags(
    body
      .replace(
        /<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi,
        " "
      )
      .replace(/<!--[\s\S]*?-->/g, " ")
  );
  return {
    url: url.toString(),
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars
  };
}

function resolveHref(raw: string) {
  let href = decodeEntities(raw);
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) href = decodeURIComponent(uddg[1]);
  if (href.startsWith("//")) href = `https:${href}`;
  return href;
}

async function searchDuckDuckGo(query: string, limit: number) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(10_000)
  });
  const html = await res.text();
  const results: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < limit) {
    const href = resolveHref(m[1]);
    if (!/^https?:/.test(href)) continue;
    results.push({
      title: stripTags(m[2]),
      url: href,
      snippet: stripTags(
        /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(
          html.slice(re.lastIndex, re.lastIndex + 2500)
        )?.[1] ?? ""
      )
    });
  }
  return results;
}

async function searchBing(query: string, limit: number) {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
    {
      headers: { "user-agent": UA, "accept-language": "en" },
      signal: AbortSignal.timeout(10_000)
    }
  );
  const html = await res.text();
  const results: SearchResult[] = [];
  const re =
    /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < limit) {
    let href = decodeEntities(m[1]);
    const u = /[?&]u=a1([^&]+)/.exec(href);
    if (u) {
      try {
        href = atob(u[1].replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        // keep original
      }
    }
    if (!/^https?:/.test(href) || /bing\.com/.test(href)) continue;
    results.push({
      title: stripTags(m[2]),
      url: href,
      snippet: stripTags(/<p[^>]*>([\s\S]*?)<\/p>/.exec(m[0])?.[1] ?? "")
    });
  }
  return results;
}

/** Keyless web search: DuckDuckGo first, Bing as a fallback. */
export async function searchWeb(
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  for (const engine of [searchDuckDuckGo, searchBing]) {
    try {
      const results = await engine(query, limit);
      if (results.length) return results;
    } catch {
      // try the next engine
    }
  }
  throw new Error("Search returned no results (engines may be rate-limiting)");
}
