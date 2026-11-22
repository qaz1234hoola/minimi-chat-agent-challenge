import crypto from "node:crypto";
import OpenAI from "openai";
import { db } from "./db.js";
import { embedText } from "./embedder.js";
import { SNAPSHOT_EXTRACTION_PROMPT } from "../agent/prompts.js";

const insertTurnStmt = db.prepare(`
  INSERT INTO episodic_turns (
    id, session_id, turn_index, user_message, assistant_response,
    created_at_iso, date_only, day_of_week
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertSnapshotStmt = db.prepare(`
  INSERT INTO turn_snapshots (turn_id, topic_summary, entities_json, claims_json)
  VALUES (?, ?, ?, ?)
`);

const insertFtsStmt = db.prepare(`
  INSERT INTO turns_fts (turn_id, user_message, assistant_response, topic_summary, entities_json)
  VALUES (?, ?, ?, ?, ?)
`);

const insertVecStmt = db.prepare(`
  INSERT INTO turns_vec (turn_id, embedding)
  VALUES (?, ?)
`);

const commitTurnTx = db.transaction(
  (payload: {
    turnId: string;
    sessionId: string;
    turnIndex: number;
    userMessage: string;
    assistantResponse: string;
    createdAtIso: string;
    dateOnly: string;
    dayOfWeek: string;
    topicSummary: string;
    entitiesJson: string;
    claimsJson: string;
    embedding: Float32Array;
  }) => {
    insertTurnStmt.run(
      payload.turnId,
      payload.sessionId,
      payload.turnIndex,
      payload.userMessage,
      payload.assistantResponse,
      payload.createdAtIso,
      payload.dateOnly,
      payload.dayOfWeek
    );
    insertSnapshotStmt.run(
      payload.turnId,
      payload.topicSummary,
      payload.entitiesJson,
      payload.claimsJson
    );
    insertFtsStmt.run(
      payload.turnId,
      payload.userMessage,
      payload.assistantResponse,
      payload.topicSummary,
      payload.entitiesJson
    );
    insertVecStmt.run(payload.turnId, payload.embedding);
  }
);

export async function indexTurnInBackground(params: {
  openai: OpenAI;
  model: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantResponse: string;
  timestamp: Date;
}): Promise<void> {
  try {
    const turnId = crypto.randomUUID();
    const createdAtIso = params.timestamp.toISOString();
    const dateOnly = createdAtIso.slice(0, 10);
    const dayOfWeek = params.timestamp.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    // 1. Extract structured JSON claims & entities via fast LLM call
    let topicSummary = params.userMessage.slice(0, 140);
    let entities: string[] = [];
    let claims: string[] = [];

    try {
      const extraction = await params.openai.chat.completions.create({
        model: params.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SNAPSHOT_EXTRACTION_PROMPT },
          {
            role: "user",
            content: `USER:\n${params.userMessage}\n\nASSISTANT:\n${params.assistantResponse}`,
          },
        ],
      });

      const rawJson = extraction.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(rawJson);
      if (typeof parsed.topic_summary === "string") topicSummary = parsed.topic_summary;
      if (Array.isArray(parsed.entities)) entities = parsed.entities.map(String);
      if (Array.isArray(parsed.claims)) claims = parsed.claims.map(String);
    } catch (err) {
      console.warn("[Indexer] Snapshot JSON fallback used:", err);
    }

    const entitiesJson = JSON.stringify(entities);
    const claimsJson = JSON.stringify(claims);

    // 2. Embed document locally via quantized Nomic v1.5
    const docText = [
      `Date: ${dayOfWeek}, ${dateOnly}`,
      `Topic: ${topicSummary}`,
      `User: ${params.userMessage}`,
      claims.length ? `Claims: ${claims.join("; ")}` : `Assistant: ${params.assistantResponse}`,
    ].join("\n");

    const embedding = await embedText(docText, "search_document");

    // 3. Atomic SQLite WAL transaction across all 4 tables
    commitTurnTx({
      turnId,
      sessionId: params.sessionId,
      turnIndex: params.turnIndex,
      userMessage: params.userMessage,
      assistantResponse: params.assistantResponse,
      createdAtIso,
      dateOnly,
      dayOfWeek,
      topicSummary,
      entitiesJson,
      claimsJson,
      embedding,
    });
  } catch (err) {
    console.error("[Indexer] Failed to persist turn:", err);
  }
}