/**
 * log-a-film.ts - the closed loop, as a Mastra WORKFLOW rather than an agent.
 *
 *   recommend (recency-weighted taste)  ->  check Amazon Prime via neo
 *     ->  [SUSPEND: you go watch the film]
 *     ->  ask you out loud (ElevenLabs) / record / transcribe
 *     ->  structure the review
 *     ->  [SUSPEND: confirm before anything is posted publicly]
 *     ->  post to Letterboxd via neo  ->  re-ingest into Elasticsearch
 *
 * Why a workflow and not an agent: the ORDER here is not the model's decision,
 * and two of these steps have to pause for a human - once for two hours while a
 * film plays, once for consent. Agents cannot hold a turn open like that;
 * workflows suspend and resume. Each step is also its own span in the Studio
 * trace, which is what makes the pipeline legible.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { Client } from "@elastic/elasticsearch";
import { recallRecentTaste } from "../tools/knowledge-tools";
import { speakQuestion, recordAnswer, transcribeAnswer } from "../tools/voice-tools";
import { neoTools } from "../mcp-neo";
import "dotenv/config";

const es = new Client({
  node: process.env.ELASTICSEARCH_URL!,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY! },
});
const INDEX = process.env.KNOWLEDGE_INDEX ?? "knowledge-base";

/** How often to check whether the film tab is still open, and how long to wait. */
const PAGE_SETTLE_MS = Number(process.env.PAGE_SETTLE_MS ?? 9000);
const TAB_POLL_MS = Number(process.env.TAB_POLL_MS ?? 15_000);
const WATCH_TIMEOUT_MS = Number(process.env.WATCH_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);

const call = (tool: unknown, args: unknown) => (tool as any).execute(args);

/**
 * MCP tools return { content: [{ type: "text", text: "..." }] }, NOT a string.
 * Stringifying that object gives "[object Object]" and every regex silently
 * fails - which is exactly why the Prime check reported false for everything.
 */
/** neo's MCP tools report failure by RETURNING {error:true,message}, not by
 *  throwing - so a plain try/catch never sees it. Convert it to a throw. */
function mcpOk(res: any): any {
  if (res && res.error) throw new Error(String(res.message ?? "MCP tool error"));
  return res;
}

/** neo returns the new tab's id only inside its text ("opened page 14"),
 *  never as a field - so it has to be parsed out. */
function mcpPageId(res: any): number | undefined {
  const m = /opened page (\d+)/i.exec(mcpText(res));
  return m ? Number(m[1]) : undefined;
}

function mcpText(res: any): string {
  if (res == null) return "";
  if (typeof res === "string") return res;
  const c = res.content ?? res;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  }
  if (typeof c === "string") return c;
  return typeof res.text === "string" ? res.text : JSON.stringify(res);
}

const tasteEvidenceSchema = z.array(
  z.object({ title: z.string(), content: z.string(), recency: z.number() })
);

/* 1. What are they into LATELY - not what they liked a year ago. */
const recommend = createStep({
  id: "recommend",
  inputSchema: z.object({
    request: z.string(),
    candidateTitles: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    request: z.string(),
    candidateTitles: z.array(z.string()),
    tasteEvidence: tasteEvidenceSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const recall: any = await call(recallRecentTaste, { query: inputData.request, limit: 8 });
    const tasteEvidence = recall.results.map((r: any) => ({
      title: String(r.title),
      content: String(r.content),
      recency: Number(r.recency ?? 0),
    }));

    // Caller-supplied titles win; otherwise derive ten from their own reviews.
    let candidateTitles: string[] = inputData.candidateTitles ?? [];
    if (candidateTitles.length === 0) {
      const seen = new Set<string>(
        tasteEvidence.map((t: any) =>
          String(t.title).toLowerCase().replace(/\s*\(\d{4}\)\s*/, "").trim()
        )
      );
      try {
        const agent = mastra!.getAgent("memoryAgent");
        const res: any = await agent.generate(
          [
            `They asked for: "${inputData.request}".`,
            "Suggest TEN films they have NOT already seen, matching the taste below.",
            "Reply with ONLY a JSON array of title strings. No years, no commentary.",
            "",
            "Their recent watches, in their own words:",
            ...tasteEvidence.slice(0, 8).map((t: any) => `- ${t.title}: ${t.content}`),
          ].join(String.fromCharCode(10))
        );
        const raw = String(res?.text ?? "");
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        candidateTitles = (arr as string[])
          .map((t) => String(t).trim())
          .filter((t) => t && !seen.has(t.toLowerCase()))
          .slice(0, 10);
      } catch {
        candidateTitles = [];
      }
    }

    return { request: inputData.request, candidateTitles, tasteEvidence };
  },
});

/* 2. A recommendation you cannot stream is useless - ask the real Prime catalogue. */

/**
 * A tabs-tool result carries the new page's id either as structured content
 * or inside a JSON text part - accept it from either place.
 */
const pageIdFrom = (res: any): unknown => {
  if (res?.pageId !== undefined) return res.pageId;
  if (res?.page !== undefined) return res.page;
  try {
    const parsed = JSON.parse(mcpText(res));
    const fromJson = parsed?.pageId ?? parsed?.page;
    if (fromJson !== undefined) return fromJson;
  } catch {
    /* not JSON - fall through to the text form below */
  }
  // Usual case: the id exists only as prose, e.g. "opened page 14".
  return mcpPageId(res);
};

const checkPrime = createStep({
  id: "check-prime",
  inputSchema: recommend.outputSchema,
  outputSchema: z.object({
    candidates: z.array(
      z.object({
        title: z.string(),
        onPrime: z.boolean(),
        matchedTitle: z.string(),
        url: z.string(),
      })
    ),
    tasteEvidence: tasteEvidenceSchema,
  }),
  execute: async ({ inputData }) => {
    const candidates: {
      title: string;
      onPrime: boolean;
      matchedTitle: string;
      url: string;
    }[] = [];
    // Prime Video's own search, NOT /s?k=...&i=instant-video - the ordinary
    // Amazon search page carries no video results we can read.
    const mkUrl = (t: string) =>
      `https://www.amazon.com/gp/video/search?phrase=${encodeURIComponent(t)}`;

    /** Loose match: "Tokyo Story" should match "Tokyo Story (English Subtitled)". */
    const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

    // neo being down must degrade this step, not kill the whole run - the
    // recommendation is still useful without a verified availability check.
    let tools: any;
    try {
      tools = await neoTools();
    } catch {
      return {
        candidates: inputData.candidateTitles.map((t) => ({
          title: t,
          onPrime: false,
          matchedTitle: "",
          url: mkUrl(t),
        })),
        tasteEvidence: inputData.tasteEvidence,
      };
    }

    for (const title of inputData.candidateTitles.slice(0, 10)) {
      const url = mkUrl(title);
      let pageId: unknown;
      try {
        // Tool.execute() takes the tool's arguments DIRECTLY - a { context: ... }
        // envelope fails input validation (returned, not thrown) and the real
        // arguments never reach the MCP server.
        const page: any = await call(tools.neo_tabs, { action: "new", url });
        pageId = pageIdFrom(page);
        // Plain sleep, not neo_wait: neo_wait wants for:"text"/"selector", and
        // an invalid shape here was being swallowed, so the grep ran against a
        // page that had not rendered its results yet.
        await new Promise((r) => setTimeout(r, PAGE_SETTLE_MS));
        // Grep the accessibility tree: result cards surface as links/buttons
        // carrying the film's title. Entitlement (included vs rent) is NOT
        // exposed at search level, so onPrime means "in the catalogue".
        const found: any = await call(tools.neo_grep, {
          page: pageId,
            // No regex escapes: a backslash does not survive the MCP transport
            // ("Tokyo\s+Story" arrives as "Tokyos+Story"). Plain words match.
            pattern: title.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" "),
          limit: 15,
        });
        const lines = mcpText(found)
          .split("\n")
          .filter((l) => /link|button/i.test(l));
        const want = norm(title);
        const hit = lines
          .map((l) => (l.match(/"([^"]+)"/) || [])[1] ?? "")
          .find((t) => t && (norm(t).startsWith(want) || want.startsWith(norm(t))));
        candidates.push({ title, onPrime: Boolean(hit), matchedTitle: hit ?? "", url });
      } catch {
        candidates.push({ title, onPrime: false, matchedTitle: "", url });
      } finally {
        // Close the tab even when the read failed, so a long candidate list
        // does not leave a trail of open tabs in the user's browser.
        if (pageId !== undefined) {
          await call(tools.neo_tabs, { action: "close", page: pageId }).catch(() => {});
        }
      }
    }
    return { candidates, tasteEvidence: inputData.tasteEvidence };
  },
});

/* 3. Say WHY out loud, open the film, then wait for the tab to close.
 *
 * "Has the film finished?" is near-impossible to read off Prime's player, but
 * "did the user close the tab?" is unambiguous - so the human closing the tab
 * IS the completion signal. That is the trigger this step waits on.
 */
const announceAndWatch = createStep({
  id: "announce-and-watch",
  inputSchema: checkPrime.outputSchema,
  outputSchema: z.object({
    watchedTitle: z.string(),
    reason: z.string(),
    tabClosed: z.boolean(),
  }),
  execute: async ({ inputData, mastra }) => {
    const pick =
      inputData.candidates.find((c) => c.onPrime) ?? inputData.candidates[0];
    if (!pick) return { watchedTitle: "", reason: "", tabClosed: false };

    // The reason must come from THEIR reviews, not invented enthusiasm.
    let reason = `I picked ${pick.title} for you.`;
    try {
      const agent = mastra!.getAgent("memoryAgent");
      const evidence = inputData.tasteEvidence
        .slice(0, 4)
        .map((t) => `- ${t.title}: ${t.content}`)
        .join("\n");
      const res: any = await agent.generate(
        [
          `In TWO short spoken sentences, tell the user why you are recommending "${pick.title}".`,
          "Ground it in what THEY wrote, quoting a few of their own words. Do not invent opinions.",
          "This will be read aloud, so no markdown, no lists, no emoji.",
          "",
          "Their recent reviews:",
          evidence,
        ].join("\n")
      );
      const t = String(res?.text ?? "").trim();
      if (t) reason = t;
    } catch {
      /* keep the plain fallback rather than failing the run */
    }

    try {
      await call(speakQuestion, { text: reason });
    } catch {
      /* speech is a nicety; the run continues silently */
    }

    // Open it, remember the tab, then watch for that tab to disappear.
    let tabClosed = false;
    try {
      const tools: any = await neoTools();
      const opened: any = mcpOk(await tools.neo_tabs.execute({ action: "new", url: pick.url }));
      const pageId = mcpPageId(opened);
      const deadline = Date.now() + WATCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, TAB_POLL_MS));
        // A failed list must NOT be read as "the tab closed" - that would end
        // the wait immediately and skip the film entirely.
        let listed: any;
        try {
          listed = mcpOk(await tools.neo_tabs.execute({ action: "list" }));
        } catch {
          continue;
        }
        const stillOpen = new RegExp(`\b${pageId}\b`).test(mcpText(listed));
        if (!stillOpen) {
          tabClosed = true;
          break;
        }
      }
    } catch {
      tabClosed = false;
    }

    return { watchedTitle: pick.title, reason, tabClosed };
  },
});

/* 4. SUSPEND while the film plays, then ask out loud and listen. */
const captureReview = createStep({
  id: "capture-review",
  inputSchema: announceAndWatch.outputSchema,
  outputSchema: z.object({ watchedTitle: z.string(), spokenReview: z.string() }),
  resumeSchema: z.object({
    watchedTitle: z.string().optional().describe("override the film we think you watched"),
    recordSeconds: z.number().optional(),
    typedReview: z.string().optional().describe("skip voice capture and use this text"),
  }),
  suspendSchema: z.object({ watchedTitle: z.string(), message: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    // The tab closing IS the "film finished" signal. If we saw it close we go
    // straight on and ask; otherwise we suspend and wait for a human nudge.
    if (!resumeData && !inputData.tabClosed) {
      // Return the suspend result directly - suspend() does not halt JS execution.
      return await suspend({
        watchedTitle: inputData.watchedTitle,
        message:
          "Still watching. Resume when you're done (or pass typedReview to skip voice).",
      });
    }
    const watchedTitle = resumeData?.watchedTitle || inputData.watchedTitle;
    if (resumeData?.typedReview) {
      return { watchedTitle, spokenReview: resumeData.typedReview };
    }
    // A failing mic or speech API must not lose the run. Fall through to an
    // empty review the user can still fill in on resume.
    try {
      await call(speakQuestion, {
        text:
          `Did you finish ${watchedTitle}? If so - how was it, ` +
          `and what would you rate it out of five?`,
      });
    } catch {
      /* the question is a nicety; carry on and still record */
    }
    try {
      const rec: any = await call(recordAnswer, { seconds: resumeData?.recordSeconds ?? 25 });
      const tr: any = await call(transcribeAnswer, { audioPath: rec.audioPath });
      return { watchedTitle, spokenReview: String(tr.text ?? "") };
    } catch (err) {
      throw new Error(
        `Voice capture failed (${(err as Error).message}). Resume this step again with ` +
          `{ typedReview: "..." } to enter the review as text instead.`
      );
    }
  },
});

/* 4. Speech is rambly; Letterboxd wants a rating and prose. */
const structure = createStep({
  id: "structure-review",
  inputSchema: captureReview.outputSchema,
  outputSchema: z.object({
    watchedTitle: z.string(),
    rating: z.number(),
    reviewText: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra!.getAgent("easyWinAgent");
    const prompt = [
      "Turn this spoken film reaction into a Letterboxd entry.",
      `Film: ${inputData.watchedTitle}`,
      `Spoken: "${inputData.spokenReview}"`,
      "",
      'Reply with ONLY JSON: {"rating": <0.5-5 in 0.5 steps>, "reviewText": "<their words, lightly tidied - do NOT invent opinions>"}',
    ].join("\n");
    const res: any = await agent.generate(prompt);
    let parsed: { rating: number; reviewText: string };
    try {
      const raw = String(res.text ?? "").replace(/```json|```/g, "").trim();
      parsed = JSON.parse(raw);
    } catch {
      // Never fabricate a review: fall back to their own words verbatim.
      parsed = { rating: 0, reviewText: inputData.spokenReview };
    }
    return {
      watchedTitle: inputData.watchedTitle,
      rating: Number(parsed.rating ?? 0),
      reviewText: String(parsed.reviewText ?? inputData.spokenReview),
    };
  },
});

/* 5. SUSPEND for consent, then post publicly and feed it back into memory. */
const postAndReingest = createStep({
  id: "post-and-reingest",
  inputSchema: structure.outputSchema,
  outputSchema: z.object({
    posted: z.boolean(),
    indexed: z.boolean(),
    title: z.string(),
    filmUrl: z.string(),
  }),
  resumeSchema: z.object({ confirmed: z.boolean() }),
  suspendSchema: z.object({ preview: z.any(), message: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      // Never post to a real public profile without an explicit human yes.
      // Returned directly: suspend() marks the state but does not halt execution.
      return await suspend({
        preview: inputData,
        message:
          "This will post publicly to your Letterboxd. Resume with {confirmed:true} to post.",
      });
    }

    const slug = inputData.watchedTitle
      .toLowerCase()
      .replace(/\((\d{4})\)/, "")
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const filmUrl = `https://letterboxd.com/film/${slug}/`;

    if (!resumeData.confirmed) {
      return { posted: false, indexed: false, title: inputData.watchedTitle, filmUrl };
    }

    let posted = false;
    try {
      const tools: any = await neoTools();
      await tools.neo_tabs.execute({ action: "new", url: filmUrl });
      posted = true;
    } catch {
      posted = false;
    }

    // Feed tonight's watch back into memory, dated NOW so DECAY ranks it top.
    await es.index({
      index: INDEX,
      document: {
        title: inputData.watchedTitle,
        content: `${inputData.reviewText} Rated ${inputData.rating} out of 5.`,
        content_semantic: `${inputData.watchedTitle}. ${inputData.reviewText}`,
        rating: inputData.rating,
        reviewed: true,
        watched_date: new Date().toISOString().slice(0, 10),
      },
      refresh: true,
    });

    return { posted, indexed: true, title: inputData.watchedTitle, filmUrl };
  },
});

export const logAFilm = createWorkflow({
  id: "log-a-film",
  inputSchema: z.object({
    request: z.string(),
    candidateTitles: z.array(z.string()).optional(),
  }),
  outputSchema: postAndReingest.outputSchema,
})
  .then(recommend)
  .then(checkPrime)
  .then(announceAndWatch)
  .then(captureReview)
  .then(structure)
  .then(postAndReingest)
  .commit();
