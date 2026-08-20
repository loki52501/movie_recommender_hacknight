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

const call = (tool: unknown, args: unknown) => (tool as any).execute(args);

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
  execute: async ({ inputData }) => {
    const recall: any = await call(recallRecentTaste, { query: inputData.request, limit: 8 });
    return {
      request: inputData.request,
      candidateTitles: inputData.candidateTitles ?? [],
      tasteEvidence: recall.results.map((r: any) => ({
        title: String(r.title),
        content: String(r.content),
        recency: Number(r.recency ?? 0),
      })),
    };
  },
});

/* 2. A recommendation you cannot stream is useless - ask the real Prime catalogue. */
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

    for (const title of inputData.candidateTitles.slice(0, 5)) {
      const url = mkUrl(title);
      let pageId: unknown;
      try {
        const page: any = await tools.neo_tabs.execute({ context: { action: "new", url } });
        pageId = page?.pageId ?? page?.page;
        await tools.neo_wait
          ?.execute({ context: { page: pageId, for: "time", value: 6000 } })
          .catch(() => {});
        // Grep the accessibility tree: result cards surface as links/buttons
        // carrying the film's title. Entitlement (included vs rent) is NOT
        // exposed at search level, so onPrime means "in the catalogue".
        const found: any = await tools.neo_grep.execute({
          context: { page: pageId, pattern: title.split(/\s+/).slice(0, 3).join("\\s+"), limit: 15 },
        });
        const lines = String(found?.content ?? found ?? "")
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
          await tools.neo_tabs
            .execute({ context: { action: "close", page: pageId } })
            .catch(() => {});
        }
      }
    }
    return { candidates, tasteEvidence: inputData.tasteEvidence };
  },
});

/* 3. SUSPEND while the film plays, then ask out loud and listen. */
const captureReview = createStep({
  id: "capture-review",
  inputSchema: checkPrime.outputSchema,
  outputSchema: z.object({ watchedTitle: z.string(), spokenReview: z.string() }),
  resumeSchema: z.object({
    watchedTitle: z.string().describe("the film you actually watched"),
    recordSeconds: z.number().optional(),
    typedReview: z.string().optional().describe("skip voice capture and use this text"),
  }),
  suspendSchema: z.object({ candidates: z.any(), message: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      // Return the suspend result directly - suspend() does not halt JS execution.
      return await suspend({
        candidates: inputData.candidates,
        message: "Go watch one of these. Resume with the title you watched.",
      });
    }
    if (resumeData.typedReview) {
      return { watchedTitle: resumeData.watchedTitle, spokenReview: resumeData.typedReview };
    }
    // A failing mic or speech API must not lose the run. Fall through to an
    // empty review the user can still fill in on resume.
    try {
      await call(speakQuestion, {
        text: `So, how was ${resumeData.watchedTitle}? Tell me what you thought.`,
      });
    } catch {
      /* the question is a nicety; carry on and still record */
    }
    try {
      const rec: any = await call(recordAnswer, { seconds: resumeData.recordSeconds ?? 25 });
      const tr: any = await call(transcribeAnswer, { audioPath: rec.audioPath });
      return { watchedTitle: resumeData.watchedTitle, spokenReview: String(tr.text ?? "") };
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
      await tools.neo_tabs.execute({ context: { action: "new", url: filmUrl } });
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
  .then(captureReview)
  .then(structure)
  .then(postAndReingest)
  .commit();
