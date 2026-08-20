/**
 * mcp-neo.ts - one shared MCP client pointed at BrowserOS neo.
 *
 * neo is a real browser already signed into the user's accounts, so the
 * workflow can check what's streamable on Prime and post a review to
 * Letterboxd as the user, without handling any credentials itself.
 *
 * Tools arrive namespaced as neo_navigate, neo_snapshot, neo_act, neo_read, ...
 */
import { MCPClient } from "@mastra/mcp";

export const NEO_URL = process.env.NEO_MCP_URL ?? "http://127.0.0.1:9010/mcp";

export const neoMcp = new MCPClient({
  id: "neo",
  servers: { neo: { url: new URL(NEO_URL) } },
});

/** Tools for an agent step. Throws a readable error if neo isn't running. */
export async function neoTools() {
  try {
    return await neoMcp.listTools();
  } catch (err) {
    throw new Error(
      `Could not reach BrowserOS neo at ${NEO_URL}. Is it running? (${(err as Error).message})`
    );
  }
}
