export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: string;
  results: WebSearchResult[];
}

function resultLimit(value?: number): number {
  return Math.max(1, Math.min(10, Number(value) || 6));
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
  return response.json();
}

async function brave(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = process.env.PERCH_BRAVE_API_KEY || process.env.BRAVE_API_KEY;
  if (!key) throw new Error("Set PERCH_BRAVE_API_KEY to use Brave search");
  const data = await requestJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { headers: { accept: "application/json", "x-subscription-token": key } },
  );
  return (data.web?.results ?? []).slice(0, limit).map((item: any) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: stripHtml(String(item.description ?? "")),
  }));
}

async function tavily(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = process.env.PERCH_TAVILY_API_KEY;
  if (!key) throw new Error("Set PERCH_TAVILY_API_KEY to use Tavily search");
  const data = await requestJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: "basic" }),
  });
  return (data.results ?? []).slice(0, limit).map((item: any) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: stripHtml(String(item.content ?? "")),
  }));
}

async function searxng(query: string, limit: number): Promise<WebSearchResult[]> {
  const base = (process.env.PERCH_SEARXNG_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("Set PERCH_SEARXNG_URL to use SearXNG search");
  const data = await requestJson(`${base}/search?q=${encodeURIComponent(query)}&format=json`);
  return (data.results ?? []).slice(0, limit).map((item: any) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: stripHtml(String(item.content ?? item.snippet ?? "")),
  }));
}

async function exa(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = process.env.PERCH_EXA_API_KEY;
  if (!key) throw new Error("Set PERCH_EXA_API_KEY to use Exa search");
  const data = await requestJson("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 600 } } }),
  });
  return (data.results ?? []).slice(0, limit).map((item: any) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: stripHtml(String(item.text ?? "")).slice(0, 600),
  }));
}

export async function webSearch(query: string, limit?: number): Promise<WebSearchResponse> {
  const text = String(query ?? "").trim();
  if (!text) throw new Error("web_search needs a query");
  const count = resultLimit(limit);
  const provider = (process.env.PERCH_SEARCH_PROVIDER || "disabled").trim().toLowerCase();
  if (!provider || provider === "disabled" || provider === "off" || provider === "none") {
    throw new Error(
      "Web search is disabled. Set PERCH_SEARCH_PROVIDER to brave, tavily, searxng or exa and configure the matching credentials.",
    );
  }
  let results: WebSearchResult[];
  if (provider === "brave") results = await brave(text, count);
  else if (provider === "tavily") results = await tavily(text, count);
  else if (provider === "searxng") results = await searxng(text, count);
  else if (provider === "exa") results = await exa(text, count);
  else throw new Error(`Unknown search provider: ${provider}`);
  return { provider, results: results.filter((result) => result.url) };
}
