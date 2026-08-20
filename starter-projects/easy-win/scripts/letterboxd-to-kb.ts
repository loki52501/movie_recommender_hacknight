/**
 * letterboxd-to-kb.ts - convert a Letterboxd RSS pull into the knowledge-base
 * shape that ingest-knowledge.ts expects: {title, content, ...metadata}.
 *
 *   npx tsx scripts/letterboxd-to-kb.ts
 *
 * The user's review text is copied VERBATIM - typos, phrasing and all. That
 * text is the whole point: it is the part no LLM can already know. Anything
 * appended is a plain restatement of the structured fields (rating, liked,
 * rewatch, date) and never an invented opinion.
 */
import { readFile, writeFile } from "node:fs/promises";

const IN = "./letterboxd-raw.json";
const OUT = "./sample-data/movies.json";

type Raw = {
  title: string; year: string; rating: string; liked: string;
  rewatch: string; watched_date: string; review_text: string; letterboxd_url: string;
};

/** Letterboxd fills the description with this when a film was logged but never reviewed. */
const PLACEHOLDER = /^Watched on \w+ \w+ \d+, \d{4}\.?$/;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

/** "2025-08-13" -> "August 2025"; empty input yields empty output. */
function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}

/** Plain facts only - restated from structured fields, never inferred. */
function facts(r: Raw, reviewed: boolean): string {
  const out: string[] = [];
  if (!reviewed) out.push("Logged without a written review.");
  if (r.rating) out.push(`Rated ${Number(r.rating)} out of 5.`);
  if (r.liked === "Yes") out.push("Liked.");
  if (r.rewatch === "Yes") out.push("A rewatch.");
  const when = monthYear(r.watched_date);
  if (when) out.push(`Watched ${when}.`);
  return out.join(" ");
}

async function main() {
  const raw: Raw[] = JSON.parse(await readFile(IN, "utf8"));

  const docs = raw.map((r) => {
    const review = squash(r.review_text);
    const reviewed = review !== "" && !PLACEHOLDER.test(review);
    const tail = facts(r, reviewed);
    // Verbatim review first, then the factual tail. Never reword the review -
    // the only edit permitted is a joining period when it does not already end
    // in punctuation, so the tail does not run into the last word.
    const joined = /[.!?…]$/.test(review) ? review : `${review}.`;
    const content = reviewed ? (tail ? `${joined} ${tail}` : review) : tail;

    return {
      title: r.year ? `${r.title} (${r.year})` : r.title,
      content,
      rating: r.rating ? Number(r.rating) : null,
      liked: r.liked === "Yes",
      rewatch: r.rewatch === "Yes",
      watched_date: r.watched_date ?? "",
      reviewed,
      url: r.letterboxd_url,
    };
  });

  const bad = docs.filter((d) => !d.title.trim() || !d.content.trim());
  if (bad.length) {
    console.error(`Refusing to write: ${bad.length} entries have an empty title or content.`);
    process.exit(1);
  }

  await writeFile(OUT, JSON.stringify(docs, null, 2) + "\n", "utf8");
  console.log(`Wrote ${docs.length} entries to ${OUT}`);
  console.log(`  with a written review: ${docs.filter((d) => d.reviewed).length}`);
  console.log(`  logged, unreviewed:    ${docs.filter((d) => !d.reviewed).length}`);
  console.log("\nFirst two entries:");
  console.log(JSON.stringify(docs.slice(0, 2), null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
