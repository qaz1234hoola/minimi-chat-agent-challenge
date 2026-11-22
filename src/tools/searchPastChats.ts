import { db } from "../memory/db.js";
import { embedText } from "../memory/embedder.js";

export interface PastChatSearchInput {
  semantic_query: string;
  keywords?: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string;   // YYYY-MM-DD
  limit?: number;
}

export interface HydratedTurn {
  turn_id: string;
  session_id: string;
  date_only: string;
  day_of_week: string;
  user_message: string;
  assistant_response: string;
  topic_summary: string | null;
  entities: string[];
  claims: string[];
  rrf_score: number;
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sanitizeFtsQuery(raw: string): string {
  // Strip FTS5 special operators and join alphanumeric tokens with OR for safe BM25 matching
  const tokens = raw
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export async function searchPastChats(input: PastChatSearchInput): Promise<HydratedTurn[]> {
  const topK = input.limit ?? 5;
  const hasDateFilter = Boolean(input.date_from || input.date_to);

  // Stage 1: Deterministic SQL B-Tree date filter (+/- 1 day timezone buffer)
  let allowedIds: Set<string> | null = null;
  if (hasDateFilter) {
    const start = shiftDate(input.date_from ?? input.date_to!, -1);
    const end = shiftDate(input.date_to ?? input.date_from!, 1);
    const rows = db
      .prepare(`SELECT id FROM episodic_turns WHERE date_only BETWEEN ? AND ?`)
      .all(start, end) as { id: string }[];

    if (rows.length === 0) return [];
    allowedIds = new Set(rows.map((r) => r.id));
  }

  // Stage 2A: Vector similarity search via sqlite-vec (768d cosine distance)
  const queryVec = await embedText(input.semantic_query, "search_query");
  const vecLimit = allowedIds ? Math.max(50, topK * 10) : topK * 4;
  const rawVecRows = db
    .prepare(
      `SELECT turn_id, distance
       FROM turns_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryVec, vecLimit) as { turn_id: string; distance: number }[];

  const vecRanked = allowedIds
    ? rawVecRows.filter((r) => allowedIds!.has(r.turn_id))
    : rawVecRows;

  // Stage 2B: Lexical BM25 search via FTS5
  const ftsInput = sanitizeFtsQuery(input.keywords || input.semantic_query);
  let ftsRanked: { turn_id: string }[] = [];
  if (ftsInput) {
    const rawFtsRows = db
      .prepare(
        `SELECT turn_id
         FROM turns_fts
         WHERE turns_fts MATCH ?
         ORDER BY bm25(turns_fts)
         LIMIT ?`
      )
      .all(ftsInput, vecLimit) as { turn_id: string }[];

    ftsRanked = allowedIds
      ? rawFtsRows.filter((r) => allowedIds!.has(r.turn_id))
      : rawFtsRows;
  }

  // Stage 3: Reciprocal Rank Fusion (RRF)
  const RRF_K = 60;
  const scores = new Map<string, number>();

  vecRanked.forEach((row, idx) => {
    scores.set(row.turn_id, (scores.get(row.turn_id) ?? 0) + 1 / (RRF_K + idx + 1));
  });

  ftsRanked.forEach((row, idx) => {
    scores.set(row.turn_id, (scores.get(row.turn_id) ?? 0) + 1 / (RRF_K + idx + 1));
  });

  // Fallback: if a pure date query ("What did I ask on 3 Nov?") had weak keyword overlap,
  // still include chronological turns from that date window
  if (allowedIds && scores.size < topK) {
    for (const id of allowedIds) {
      if (!scores.has(id)) scores.set(id, 0.001);
    }
  }

  const winningIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);

  if (winningIds.length === 0) return [];

  // Stage 4: Hydrate winning turn IDs with raw conversation + extracted claims
  const placeholders = winningIds.map(() => "?").join(",");
  const hydratedRows = db
    .prepare(
      `SELECT
         e.id AS turn_id,
         e.session_id,
         e.date_only,
         e.day_of_week,
         e.user_message,
         e.assistant_response,
         s.topic_summary,
         s.entities_json,
         s.claims_json
       FROM episodic_turns e
       LEFT JOIN turn_snapshots s ON e.id = s.turn_id
       WHERE e.id IN (${placeholders})`
    )
    .all(...winningIds) as any[];

  const rowMap = new Map(hydratedRows.map((r) => [r.turn_id, r]));

  return winningIds
    .map((id) => {
      const r = rowMap.get(id);
      if (!r) return null;
      return {
        turn_id: r.turn_id,
        session_id: r.session_id,
        date_only: r.date_only,
        day_of_week: r.day_of_week,
        user_message: r.user_message,
        assistant_response: r.assistant_response,
        topic_summary: r.topic_summary ?? null,
        entities: r.entities_json ? JSON.parse(r.entities_json) : [],
        claims: r.claims_json ? JSON.parse(r.claims_json) : [],
        rrf_score: Number((scores.get(id) ?? 0).toFixed(5)),
      };
    })
    .filter((x): x is HydratedTurn => x !== null);
}