import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { db } from "../memory/db.js";
import { indexTurnInBackground } from "../memory/indexer.js";
import { searchPastChats, type PastChatSearchInput } from "../tools/searchPastChats.js";
import { webSearch } from "../tools/webSearch.js";
import { buildSystemPrompt } from "./prompts.js";

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_past_chats",
      description:
        "Search past conversation turns using hybrid semantic + keyword search and optional YYYY-MM-DD date bounds.",
      parameters: {
        type: "object",
        properties: {
          semantic_query: {
            type: "string",
            description: "Natural-language description of the past topic or question.",
          },
          keywords: {
            type: ["string", "null"],
            description: "Exact product names, brand names, or key nouns, or null.",
          },
          date_from: {
            type: ["string", "null"],
            description: "Inclusive start date in YYYY-MM-DD format, or null.",
          },
          date_to: {
            type: ["string", "null"],
            description: "Inclusive end date in YYYY-MM-DD format, or null.",
          },
        },
        required: ["semantic_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web for current pricing, product releases, news, or factual verification.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Targeted web search query.",
          },
        },
        required: ["query"],
      },
    },
  },
];

export interface StreamCallbacks {
  onStatus: (status: string) => void;
  onToken: (token: string) => void;
  onDone: () => void;
}

export async function runAgentTurn(params: {
  sessionId: string;
  userMessage: string;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1",
  });
  const model = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  const now = new Date();

  // Load 6-turn active session sliding window from SQLite
  const recentTurns = db
    .prepare(
      `SELECT turn_index, user_message, assistant_response
       FROM episodic_turns
       WHERE session_id = ?
       ORDER BY turn_index DESC
       LIMIT 6`
    )
    .all(params.sessionId) as Array<{
    turn_index: number;
    user_message: string;
    assistant_response: string;
  }>;

  recentTurns.reverse();
  const nextTurnIndex =
    recentTurns.length > 0 ? recentTurns[recentTurns.length - 1].turn_index + 1 : 0;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(now) },
  ];

  for (const t of recentTurns) {
    messages.push({ role: "user", content: t.user_message });
    messages.push({ role: "assistant", content: t.assistant_response });
  }
  messages.push({ role: "user", content: params.userMessage });

// Autonomous agent loop (max 5 tool-calling rounds)
  for (let step = 0; step < 5; step++) {
    let assistantText = "";
    const toolCallsMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = await openai.chat.completions.create({
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantText += delta.content;
          params.callbacks.onToken(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallsMap.set(tc.index, existing);
          }
        }
      }
    } catch (err: any) {
      const errCode = err?.code || err?.error?.code;
      if (errCode === "tool_use_failed" && step < 4) {
        messages.push({
          role: "user",
          content: `System note: Your previous tool call failed schema validation (${err?.error?.message || err.message}). Retry with valid JSON types.`,
        });
        continue;
      }
      throw err;
    }

    const toolCalls = [...toolCallsMap.values()];

    // Exit condition: model produced final text with no pending tool calls
    if (toolCalls.length === 0) {
      params.callbacks.onDone();

      // Zero-latency background indexing (onFinish)
      void indexTurnInBackground({
        openai,
        model,
        sessionId: params.sessionId,
        turnIndex: nextTurnIndex,
        userMessage: params.userMessage,
        assistantResponse: assistantText,
        timestamp: now,
      });
      return;
    }

    // Record assistant tool-call request in message history
    messages.push({
      role: "assistant",
      content: assistantText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute all requested tool calls concurrently via Promise.all
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        try {
          const args = JSON.parse(tc.arguments || "{}");
          if (tc.name === "search_past_chats") {
            params.callbacks.onStatus(
              `Searching past chats${args.date_from ? ` (${args.date_from})` : ""}...`
            );
            const matches = await searchPastChats(args as PastChatSearchInput);
            return { id: tc.id, output: JSON.stringify(matches) };
          }
          if (tc.name === "web_search") {
            params.callbacks.onStatus(`Searching web: "${args.query}"...`);
            const results = await webSearch(String(args.query ?? ""));
            return { id: tc.id, output: JSON.stringify(results) };
          }
          return { id: tc.id, output: JSON.stringify({ error: `Unknown tool: ${tc.name}` }) };
        } catch (err: any) {
          return {
            id: tc.id,
            output: JSON.stringify({ error: err?.message ?? "Tool execution failed" }),
          };
        }
      })
    );

    for (const res of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: res.id,
        content: res.output,
      });
    }
  }

  params.callbacks.onDone();
}