import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { db } from "./memory/db.js";
import { initEmbedder } from "./memory/embedder.js";
import { runAgentTurn } from "./agent/loop.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

// List all past chat sessions for the collapsible sidebar
app.get("/api/sessions", (_req, res) => {
  const sessions = db
    .prepare(
      `SELECT
         e.session_id,
         MIN(e.created_at_iso) AS started_at,
         MAX(e.created_at_iso) AS updated_at,
         COALESCE(
           (SELECT s.topic_summary
            FROM episodic_turns e2
            JOIN turn_snapshots s ON e2.id = s.turn_id
            WHERE e2.session_id = e.session_id
            ORDER BY e2.turn_index ASC
            LIMIT 1),
           (SELECT e3.user_message
            FROM episodic_turns e3
            WHERE e3.session_id = e.session_id
            ORDER BY e3.turn_index ASC
            LIMIT 1)
         ) AS title
       FROM episodic_turns e
       GROUP BY e.session_id
       ORDER BY updated_at DESC`
    )
    .all();

  res.json({ sessions });
});

// Load full message history when switching sessions in the sidebar
app.get("/api/sessions/:sessionId", (req, res) => {
  const turns = db
    .prepare(
      `SELECT turn_index, user_message, assistant_response, created_at_iso
       FROM episodic_turns
       WHERE session_id = ?
       ORDER BY turn_index ASC`
    )
    .all(req.params.sessionId);

  res.json({ turns });
});

// SSE streaming chat endpoint
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body as {
    sessionId?: string;
    message?: string;
  };

  if (!sessionId || !message?.trim()) {
    res.status(400).json({ error: "sessionId and message are required." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgentTurn({
      sessionId,
      userMessage: message.trim(),
      callbacks: {
        onStatus: (status) => sendEvent("status", { status }),
        onToken: (token) => sendEvent("token", { token }),
        onDone: () => {
          sendEvent("done", {});
          res.end();
        },
      },
    });
  } catch (err: any) {
    console.error("[Server] Chat error:", err);
    sendEvent("error", { message: err?.message ?? "Internal server error" });
    res.end();
  }
});

async function start() {
  await initEmbedder();
  app.listen(PORT, () => {
    console.log(`[Server] Running at http://localhost:${PORT}`);
  });
}

start();