/**
 * Mastra registration - everything here appears in Studio (`npm run dev`).
 *
 *   bare-llm-agent   - the "before": ungrounded LLM
 *   easy-win-agent   - grounded on your data via hybrid search over Elasticsearch
 *   memory-agent     - reference: Mastra's built-in Memory (semanticRecall)
 *                      using Elasticsearch as the vector store
 */
import { Mastra } from "@mastra/core";
import { Observability, MastraStorageExporter } from "@mastra/observability";
import { bareLlmAgent, easyWinAgent } from "./agents/easy-agents";
import { memoryAgent } from "./agents/memory-agent";
import { logAFilm } from "./workflows/log-a-film";

export const mastra = new Mastra({
  agents: { bareLlmAgent, easyWinAgent, memoryAgent },
  // The closed loop: recommend -> watch -> speak your review -> post -> re-ingest.
  workflows: { logAFilm },
  // Records agent traces (LLM turns, tool calls) so they show up in Studio's
  // Traces view - the demo and the judging rubric both use it.
  observability: new Observability({
    configs: {
      default: {
        serviceName: "hacknight-easy-win",
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
});
