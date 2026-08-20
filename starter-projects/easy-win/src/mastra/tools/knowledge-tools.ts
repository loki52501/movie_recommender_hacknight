/**
 * knowledge-tools.ts - EASY WIN tool: hybrid search over YOUR data.
 *
 * Elasticsearch is the vector store: the semantic branch searches the
 * server-side embeddings (semantic_text), the keyword branch catches exact
 * names/IDs, and FUSE merges them. Works on whatever `ingest-knowledge.ts`
 * loaded - no timestamps, no decay, no tuning required to get started.
 */
import { createTool } from "@mastra/core/tools";
import { Client } from "@elastic/elasticsearch";
import { z } from "zod";
import "dotenv/config";

const es = new Client({
  node: process.env.ELASTICSEARCH_URL!,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY! },
});

const INDEX = process.env.KNOWLEDGE_INDEX ?? "knowledge-base";

function esqlEscape(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 500);
}

/**
 * Retrieval tuning, and why it fits THIS corpus:
 *
 * - FUSE weights the semantic branch 3x the BM25 branch. Users ask this agent for
 *   moods ("something calm", "a film that broke me"), not titles, and the corpus is
 *   50 short personal reviews - too little text for BM25 to rank moods well. Measured
 *   over 6 realistic queries, the weighting changed ranking on 3 and improved the
 *   mood ones (e.g. "broke me emotionally" promotes Chronicle and Whiplash above
 *   Cinema Paradiso). Keyword search is kept, not dropped, because exact title and
 *   name lookups still need it.
 * - Known BM25 artifact this does NOT fully fix: "scary horror" still ranks
 *   The Rocky Horror Picture Show first on a literal title match.
 * - KEEP now returns rating / reviewed / watched_date so the agent can prefer films
 *   the user rated highly and distinguish a written review from a bare log.
 */
export const searchKnowledge = createTool({
  id: "search_knowledge",
  description:
    "Search the knowledge base (the only source of truth). Use for EVERY factual answer or " +
    "recommendation - if it's not in the knowledge base, say so rather than guessing.",
  inputSchema: z.object({
    query: z.string().describe("What to look for - a topic, a name, an ID, or a vibe"),
    limit: z.number().min(1).max(15).default(5),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
        rating: z.number().nullable(),
        reviewed: z.boolean(),
        watchedDate: z.string(),
        score: z.number(),
      })
    ),
  }),
  execute: async (input) => {
    const q = esqlEscape(input.query);
    const query = `
FROM ${INDEX} METADATA _id, _score, _index
| FORK (
    WHERE title:"${q}" OR content:"${q}"
    | SORT _score DESC | LIMIT 50
) (
    WHERE content_semantic:"${q}"
    | SORT _score DESC | LIMIT 50
)
| FUSE WITH { "weights": { "fork1": 1.0, "fork2": 3.0 } }
| SORT _score DESC | LIMIT ${input.limit}
| KEEP title, content, rating, reviewed, watched_date, _score
`.trim();

    const result = await es.esql.query({ query, format: "json" });
    const cols = (result as any).columns.map((c: { name: string }) => c.name);
    const idx = (n: string) => cols.indexOf(n);
    const results = ((result as any).values as unknown[][]).map((row) => ({
      title: String(row[idx("title")]),
      content: String(row[idx("content")]).slice(0, 800),
      // Surfaced so the agent can rank by how much they liked it, tell a real
      // review from a bare log, and avoid re-recommending what it already sees.
      rating: row[idx("rating")] === null ? null : Number(row[idx("rating")]),
      reviewed: Boolean(row[idx("reviewed")]),
      watchedDate: row[idx("watched_date")] ? String(row[idx("watched_date")]).slice(0, 10) : "",
      score: Number(row[idx("_score")]),
    }));
    return { results };
  },
});

/**
 * recallRecentTaste - the same FORK/FUSE hybrid retrieval as searchKnowledge,
 * but re-ranked by WHEN the user watched each film, for "what should I watch
 * next" requests where current taste matters more than all-time taste.
 *
 * Tuning decisions, and why:
 *
 * - WHY a 4320 hour (180 day) scale: the corpus spans 2025-06 to 2026-04, so
 *   watches are spread over ~10 months. The scale is where the decay has eaten
 *   most of the score, and 180 days sits at the corpus's midpoint - a film from
 *   ~6 months ago still carries meaningful weight. A 90 day scale would treat
 *   most of this corpus as "ancient" and flatten the ranking.
 * - The scale is written as a time_duration (`4320 hours`), NOT a date_period
 *   (`180 days`): DECAY's third argument only accepts time_duration values, and
 *   a date_period literal is rejected by ES|QL.
 * - WHY {"type":"exp"}: the DEFAULT decay curve hard-cliffs to exactly 0.0
 *   beyond the scale, which would zero out every watch older than the scale and
 *   collapse them into unrankable ties. "exp" decays smoothly and never fully
 *   reaches 0, so an old-but-relevant film can still surface. Deliberate choice.
 * - WHY combined = _score * (0.4 + 0.6 * recency): recency is a boost, not a
 *   gate. The 0.4 floor keeps 40% of the hybrid relevance score for the oldest
 *   films, so a great semantic match from last year can still outrank a
 *   mediocre match from last week; the 0.6 share lets a fresh watch climb.
 * - WHY COALESCE(watched_date, TO_DATETIME("1970-01-01T00:00:00.000Z")): some documents have an empty
 *   watched_date. DECAY over null returns null, which would poison `combined`
 *   to null and silently misplace (or drop) those rows from the sort. Pinning
 *   missing dates to 1970 gives them a recency of ~0 - they rank last, but
 *   neither crash the query nor vanish.
 */
export const recallRecentTaste = createTool({
  id: "recall_recent_taste",
  description:
    "Recall what the user has been into LATELY. Same hybrid search as " +
    "search_knowledge, but recency-weighted so recent watches outrank older ones. " +
    "Use this for 'what should I watch' style requests.",
  inputSchema: z.object({
    query: z.string().describe("What to look for - a topic, a vibe, or a title"),
    limit: z.number().min(1).max(15).default(5),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
        rating: z.number().nullable(),
        reviewed: z.boolean(),
        watchedDate: z.string(),
        score: z.number(),
        recency: z.number(),
      })
    ),
  }),
  execute: async (input) => {
    const q = esqlEscape(input.query);
    const query = `
FROM ${INDEX} METADATA _id, _score, _index
| FORK (
    WHERE title:"${q}" OR content:"${q}"
    | SORT _score DESC | LIMIT 50
) (
    WHERE content_semantic:"${q}"
    | SORT _score DESC | LIMIT 50
)
| FUSE WITH { "weights": { "fork1": 1.0, "fork2": 3.0 } }
| EVAL recency = DECAY(COALESCE(watched_date, TO_DATETIME("1970-01-01T00:00:00.000Z")), NOW(), 4320 hours, {"type":"exp"})
| EVAL combined = _score * (0.4 + 0.6 * recency)
| SORT combined DESC
| LIMIT ${input.limit}
| KEEP title, content, rating, reviewed, watched_date, recency, combined
`.trim();

    const result = await es.esql.query({ query, format: "json" });
    const cols = (result as any).columns.map((c: { name: string }) => c.name);
    const idx = (n: string) => cols.indexOf(n);
    const results = ((result as any).values as unknown[][]).map((row) => ({
      title: String(row[idx("title")]),
      content: String(row[idx("content")]).slice(0, 800),
      rating: row[idx("rating")] === null ? null : Number(row[idx("rating")]),
      reviewed: Boolean(row[idx("reviewed")]),
      watchedDate: row[idx("watched_date")] ? String(row[idx("watched_date")]).slice(0, 10) : "",
      // The DECAY pipeline drops _score from KEEP, so `score` is the combined
      // (relevance * recency-boosted) score the rows were actually sorted by.
      score: Number(row[idx("combined")]),
      recency: Number(row[idx("recency")]),
    }));
    return { results };
  },
});
