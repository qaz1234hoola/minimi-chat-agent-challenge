export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is missing in environment variables.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "fast",
      max_results: 3,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };

  return (data.results ?? []).map((item) => ({
    title: item.title ?? "Untitled",
    url: item.url ?? "",
    snippet: (item.content ?? "").slice(0, 350),
    published_date: item.published_date,
  }));
}