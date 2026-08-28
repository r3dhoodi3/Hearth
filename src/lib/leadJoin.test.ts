import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEAD_CONTRACTOR_EMBED, leadContractorEmbed } from "./leadJoin";

// The bug this file exists to stop coming back.
//
// contractor_leads has had two foreign keys into contractors since migration
// 0105 added direct_to. From that moment a plain `contractors(...)` embed on
// contractor_leads became ambiguous, and PostgREST answers an ambiguous embed
// with HTTP 300 / PGRST201 and NO ROWS. supabase-js reports that as `error`,
// not as a throw, so three screens that all wrote `const { data } = await ...`
// silently rendered empty lists for months: "Your jobs" on /contractors (a
// homeowner posted a job, the row landed, and the page showed them nothing -
// while the success banner linked to a #your-jobs anchor that was not in the
// document), the conversation list on /chats, and the pro name in the new
// message toast.
//
// A grep-shaped test, deliberately: the failure is a STRING in a select(), it
// costs nothing to check, and no amount of type checking would have caught it.

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("leadContractorEmbed", () => {
  it("names the contractor_id foreign key, not the direct_to one", () => {
    expect(LEAD_CONTRACTOR_EMBED).toBe(
      "contractors!contractor_leads_contractor_id_fkey"
    );
    expect(leadContractorEmbed("name, rating")).toBe(
      "contractors!contractor_leads_contractor_id_fkey(name, rating)"
    );
  });

  it("keeps the embedded object under the plain `contractors` key", () => {
    // Callers read row.contractors?.name. The !hint only picks which
    // relationship to follow; it must not become part of the key, or every
    // one of those reads goes undefined.
    expect(leadContractorEmbed("name").startsWith("contractors!")).toBe(true);
  });

  it("no source file embeds contractors off contractor_leads without the hint", () => {
    // The one bare `contractors(...)` embed in the tree that is CORRECT:
    // lead_applications has exactly one foreign key into contractors
    // (migration 0012), so nothing about it is ambiguous and adding a hint
    // there would only be noise. Listed by its own select string so a new bare
    // embed elsewhere on that table still gets caught.
    const allowedBareEmbeds = [
      "id, lead_id, contractor_id, message, created_at, status, refunded_at, contractors(",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      // Only files that talk to contractor_leads at all can trip the
      // ambiguity. Matches the bare table name, not just the double-quoted
      // literal - a single-quoted string or a template literal names the
      // same table and is just as able to carry the bare embed.
      if (!text.includes("contractor_leads")) continue;
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        // Prose about the bug is not the bug.
        if (line.startsWith("//") || line.startsWith("*")) continue;
        // A bare embed is `contractors(` with no `!hint` in front of it.
        if (!/(^|[^!\w])contractors\(/.test(line)) continue;
        if (line.includes("!contractor_leads_")) continue;
        if (allowedBareEmbeds.some((a) => line.includes(a))) continue;
        offenders.push(`${file}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
