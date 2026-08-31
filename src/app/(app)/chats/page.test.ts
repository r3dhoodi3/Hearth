import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// A source test, same idiom as src/app/pro/chats/page.test.ts and for the
// same reason: this page imports the server Supabase client and "server-only"
// modules, so it throws the moment it is imported outside a real server
// render. The rendered tab behavior itself is covered by
// src/components/ChatListTabs.test.tsx (the exact component this page hands
// its rows to) and, on the pro side, by ChatsView.test.tsx.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

describe("homeowner Messages: Active / Closed tabs", () => {
  it("fetches the lead status the split needs, in both lead reads", () => {
    // The main list read and the cross-home deep-link read both feed the
    // tabs, so both must carry the status column.
    const selects = page.match(
      /id, category, contractor_id, status, created_at/g
    );
    expect(selects?.length).toBe(2);
  });

  it("classifies with the shared closed/lost set, not a local copy", () => {
    // isTerminalLeadStatus lives next to STATUS_LABEL in
    // src/app/pro/leadStatusLabel.ts, the same source JobStatusSelect and
    // LeadsBoard build on, so the inboxes and the pipeline cannot drift.
    expect(page).toContain(
      'import { isTerminalLeadStatus } from "@/app/pro/leadStatusLabel"'
    );
    expect(page).toContain(
      "const activeConvos = convos.filter((l) => !isTerminalLeadStatus(l.status))"
    );
    expect(page).toContain(
      "const closedConvos = convos.filter((l) => isTerminalLeadStatus(l.status))"
    );
    // No second, hand-rolled classification hiding anywhere in the page.
    expect(page).not.toMatch(/===\s*"closed"/);
    expect(page).not.toMatch(/===\s*"lost"/);
  });

  it("renders the list through the shared ChatListTabs, split by tab", () => {
    expect(page).toContain("<ChatListTabs");
    expect(page).toContain("activeRows={activeConvos.map(renderConvoRow)}");
    expect(page).toContain("closedRows={closedConvos.map(renderConvoRow)}");
  });

  it("pins Ask Hearth outside the filter so it survives both tabs", () => {
    // The assistant row goes through the `pinned` prop, which ChatListTabs
    // renders above the filtered rows on every tab.
    const pinnedBlock = page.slice(
      page.indexOf("pinned={"),
      page.indexOf("activeRows={")
    );
    expect(pinnedBlock).toContain("<AskHearthRow");
  });

  it("starts on Closed only when the open thread is a finished one", () => {
    const tabBlock = page.slice(
      page.indexOf("initialTab={"),
      page.indexOf("activeCount={")
    );
    expect(tabBlock).toContain("isTerminalLeadStatus((selected as any).status)");
  });

  it("carries both empty states in plain words", () => {
    expect(page).toContain(
      "No open conversations yet. Pick a pro for a job and your chat starts here."
    );
    expect(page).toContain(
      "Nothing here yet. Finished conversations land here."
    );
  });
});
