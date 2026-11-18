# Architecture & Design (`DESIGN.md`)

## 1. How It Works

The system is a single-loop tool-calling agent built on Node.js/TypeScript backed by **Temporal-Hybrid Episodic Memory** and live **Web Search**.

```text
+------------------------------------------------------------------------------+
| 1. INGEST & CONTEXT ASSEMBLY                                                 |
|                                                                              |
|  User Message + Active Session Window (last 6 turns) + Server ISO Timestamp  |
+--------------------------------------+---------------------------------------+
                                       |
                                       v
+------------------------------------------------------------------------------+
| 2. AUTONOMOUS AGENT LOOP (Node.js / TypeScript)                              |
|                                                                              |
|  * System prompt injects exact current date & day of week                    |
|  * Resolves relative dates ("Last Tuesday" -> YYYY-MM-DD)                    |
|  * Loops over tool calls until ready to synthesize final answer              |
+-------------------+--------------------------------------+-------------------+
                    |                                      |
      (if past context needed)               (if live verification needed)
                    |                                      |
                    v                                      v
+---------------------------------------+  +-----------------------------------+
| Tool: search_past_chats               |  | Tool: web_search                  |
|                                       |  |                                   |
| 1. SQL Date Filter (B-Tree +/- 1 day) |  | * Runs targeted queries using     |
| 2. FTS5 (BM25) + sqlite-vec (768d)    |  |   retrieved entities & claims     |
| 3. RRF Fusion: 1/(60+r1) + 1/(60+r2)  |  | * Parallelizable across items     |
| 4. Hydrate turns + claim snapshots    |  |                                   |
+-------------------+-------------------+  +-----------------+-----------------+
                    ^                                        |
                    | (read)                                 | (live results)
                    |                                        v
+-------------------+-------------------+  +-----------------------------------+
| SQLite Storage (WAL Mode, Single .db) |  | 3. STREAM RESPONSE                |
|                                       |  |                                   |
| * episodic_turns (raw pairs + dates)  |  | * Streams diff/answer over HTTP   |
| * turn_snapshots (JSON claims/entities|  |   immediately to user             |
| * turns_fts      (FTS5 keyword index) |  +-----------------+-----------------+
| * turns_vec      (vec0 Float32[768])  |                    |
+-------------------+-------------------+                    | (onFinish hook)
                    ^                                        v
                    | (atomic transaction) +-----------------------------------+
                    +----------------------+ 4. ASYNC BACKGROUND INDEXING      |
                                           |                                   |
                                           | * Extract JSON summary & claims   |
                                           | * Local embed via Nomic v1.5 (q8) |
                                           |   ("search_document: " prefix)    |
                                           +-----------------------------------+
```

* **Temporal Grounding:** Every request injects the server's exact ISO timestamp and day of the week into the system prompt so the model deterministically resolves relative dates (*"Last Tuesday"*, *"On Monday"*, *"3 November"*) into `YYYY-MM-DD` bounds.
* **Coupled Episodic Storage:** Instead of naive message chunking, every complete exchange (`user_message` + `assistant_response`) is stored as an atomic turn in SQLite (`better-sqlite3`), paired with an extracted `turn_snapshots` row containing the topic summary, named entities, and specific claims/prices quoted by the assistant.
* **Three-Stage Hybrid Retrieval:** When `search_past_chats` is invoked:
  1. **Deterministic Date Filter:** narrows candidates via an indexed `date_only` column (with a `±1 day` buffer to absorb UTC/local timezone boundary shifts).
  2. **Lexical + Semantic Ranking:** combines `FTS5` (BM25 for exact product/brand names) and `sqlite-vec` (`Float32Array` cosine similarity for conceptual phrasing) via **Reciprocal Rank Fusion (RRF)**.
  3. **Verification Loop:** The agent inspects the retrieved past claims and fires targeted, parallel `web_search` queries to diff historical facts against live state.
* **Zero-Latency Write Path:** The active session's recent turns stay in memory for instant follow-ups. After the HTTP stream closes (`onFinish`), a background task extracts the structured snapshot, generates an on-device embedding via `@huggingface/transformers` (`nomic-ai/nomic-embed-text-v1.5`, 768 dims, 8K context, using `search_document:` / `search_query:` task prefixes), and commits to SQLite.

---

## 2. Why I Built It This Way

* **Solving Temporal Blindness & State Diffing:** Standard vector RAG fails on *"What did I ask on 3 November? Is your answer still correct today?"* because embeddings cannot resolve calendar math and naive chunking separates the user's question from the assistant's prior claims. Pairing SQL date indexes with stored assistant snapshots lets the agent verify exact historical statements against current web results.
* **Low End-to-End Latency:** Eliminating pre-classification routers saves 1–2 serial LLM roundtrips per turn, while deferring snapshot extraction and embedding to `onFinish` keeps time-to-first-token fast.
* **Zero-Friction Portability (`npm install && npm run dev`):** Running SQLite (`better-sqlite3` + `sqlite-vec` + `FTS5`) and local ONNX embeddings inside the Node process requires zero external databases, Docker containers, or extra embedding API keys—just a single `.db` file on disk.

---

## 3. What I Considered and Rejected

* **Pure Vector RAG:** Rejected because cosine similarity blurs proper nouns (e.g., specific CRM/database vendors) and has no reliable representation of relative dates like *"last Tuesday"*.
* **Sequential LLM Gatekeeper / Query-Rewriter Pipeline:** Rejected an initial design that routed every prompt through an `LLM Judge -> LLM Rewriter -> RAG -> Agent` chain. Serial LLM calls add unacceptable latency on simple queries and break down if an early classifier misroutes an implicit reference; letting one tool-capable agent inspect results and retry wider date ranges autonomously is faster and more resilient.
* **LanceDB / External Vector Stores:** Rejected LanceDB in favor of SQLite because our primary access pattern requires relational `BETWEEN` date filtering, foreign-key joins between raw turns and claim snapshots, and built-in BM25 keyword search—all with a lighter native Node footprint.
* **Cloud Embedding APIs:** Rejected to minimize `.env` API key dependencies and eliminate network roundtrips during retrieval; warming up `nomic-embed-text-v1.5` at server startup keeps query embedding latency under ~40ms locally.

---

## 4. What I'd Do With Another Week

1. **Cross-Encoder Reranking:** Add a lightweight local reranker on top of the top-15 RRF candidates before injecting context into the prompt to further improve precision on dense multi-month histories.
2. **Proactive Session Consolidation:** Run a background job to merge fragmented multi-turn discussions into canonical entity/decision records (e.g., tracking how a shortlisted set of tools evolved across multiple days) and expire superseded facts.
3. **Automated Temporal-Diff Eval Suite:** Build a deterministic benchmark simulating multi-week chat histories with synthetic price/release changes to regression-test date-window accuracy, timezone edge cases, and hallucinated diffs.
