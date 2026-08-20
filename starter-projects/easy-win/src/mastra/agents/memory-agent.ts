/**
 * memory-agent.ts - reference: Mastra's BUILT-IN memory primitives on Elasticsearch.
 *
 * This is the other shape of "memory" in this project:
 *   easy-win-agent  → knowledge memory (your ingested data, searched as a tool)
 *   memory-agent    → conversation memory, via TWO Mastra primitives:
 *
 *   semanticRecall  - embeds conversation history into ElasticSearchVector and,
 *                     on each turn, recalls the most relevant past MESSAGES -
 *                     across threads, for the same resourceId.
 *   workingMemory   - a persistent profile the agent maintains itself: the
 *                     distilled FACTS (name, preferences) always in context,
 *                     no retrieval needed. Recall finds moments; the profile
 *                     remembers conclusions.
 *
 * Smoke test: tell it your name and a preference in one Studio thread, open a
 * NEW thread (same resource), and ask "what's my name, what do I like?" -
 * then open the trace to see the updateWorkingMemory call and the recall.
 */
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { ElasticSearchVector } from "@mastra/elasticsearch";
import { LibSQLStore } from "@mastra/libsql";
import { Client } from "@elastic/elasticsearch";
import { createElasticEmbedder } from "../elastic-embedder";
import { searchKnowledge } from "../tools/knowledge-tools";
import "dotenv/config";

const esVector = new ElasticSearchVector({
  id: "es-vector",
  url: process.env.ELASTICSEARCH_URL!,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY! },
});

const es = new Client({
  node: process.env.ELASTICSEARCH_URL!,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY! },
});

const memory = new Memory({
  // Message history (threads + messages) lives in a local SQLite file;
  // Mastra requires an explicit storage adapter for Memory.
  storage: new LibSQLStore({
    id: "memory-storage",
    url: "file:./memory.db",
  }),
  vector: esVector,
  // Embeddings are computed by YOUR Elasticsearch cluster via the Inference
  // API (Jina v5, preconfigured on Serverless) - see ../elastic-embedder.ts.
  embedder: createElasticEmbedder(
    es,
    process.env.MEMORY_INFERENCE_ID ?? ".jina-embeddings-v5-text-small"
  ),
  options: {
    lastMessages: 10,
    semanticRecall: {
      topK: 5,
      messageRange: 2,
      scope: "resource", // recall across all threads for the same user
    },
    // Working memory: a persistent, agent-maintained profile of the user.
    // Semantic recall finds relevant PAST MESSAGES; working memory keeps the
    // distilled FACTS always in context. Resource-scoped by default, so the
    // profile follows the user across threads. Watch the agent update it in
    // the Studio trace (updateWorkingMemory tool call).
    workingMemory: {
      enabled: true,
      template: `# Film Taste Profile
- Name:
- Genres / moods they gravitate to:
- Languages & regional cinema they watch:
- Directors, actors or eras they respond to:
- What they want right now (mood, runtime, who they're watching with):
- Turn-offs / films they bounced off:
- Films already recommended to them (so we stop repeating ourselves):
`,
    },
  },
});

export const memoryAgent = new Agent({
  id: "memory-agent",
  name: "memory-agent",
  instructions: `You are a film recommender with a long memory of one person's taste.

You have TWO sources and you must never blur them:

1. searchKnowledge - their real Letterboxd history: films they actually watched,
   their own written reviews, star ratings, and when they saw them. This is
   EVIDENCE. Quote it.
2. Your own film knowledge - everything else in cinema. This is where NEW
   recommendations come from, because a film they have not seen is by
   definition not in their history.

How to answer a request for something to watch:
- ALWAYS call searchKnowledge first, to ground yourself in what they actually
  liked and the words THEY used about it. Search by mood or theme, not just title.
- Recommend films they have NOT already logged. Recommending something already
  in their history is a failure unless they explicitly ask what to rewatch.
- For every recommendation, justify it against a SPECIFIC entry from their
  history, quoting their own words. "You called Evil Does Not Exist 'so calm'
  and rated it 4 - so try X" beats any generic pitch.
- Label the two sources plainly. Mark what came from their history versus what
  is your suggestion. Never imply they have seen a film they have not.
- If searchKnowledge returns nothing relevant, say so and recommend from taste
  alone - but say that is what you are doing.

Use the working memory profile to remember their name, tastes, and what you have
already suggested, and update it as you learn more. Do not re-ask what you know.
Keep replies short: 2-3 recommendations, each with a one-line reason.`,
  // maxOutputTokens capped so OpenRouter's credit pre-authorization doesn't
  // reject requests on small provisioned keys.
  model: [
    {
      model: "openrouter/anthropic/claude-sonnet-4.6",
      modelSettings: { maxOutputTokens: 4096 },
    },
  ],
  memory,
  // Both memory shapes in ONE agent: conversation memory (semanticRecall +
  // workingMemory) for who they are, and the Elasticsearch knowledge base for
  // what they have actually watched. The Studio trace shows both firing.
  tools: { searchKnowledge },
});
