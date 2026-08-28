import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it, expect, vi } from "vitest";

// The refund paths ARE importable, unlike the rest of this file's subjects:
// mocking the service-role client out means "server-only" is never pulled in,
// so the compare-and-swap can be exercised for real against a fake table
// instead of being asserted at the level of source text. See fakeAdmin below.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

// Whatever fakeAdmin() built for the test that is running. `unknown` because
// aiUsage only ever calls the handful of builder methods the fake implements.
let currentAdmin: unknown = null;

// src/lib/aiUsage.ts imports the service-role Supabase client, which is
// "server-only" and throws the moment it is imported outside a server
// component. So these assertions read the source instead of importing it,
// the same way src/lib/aiGuard.test.ts checks the two chat routes.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const aiUsage = src("./aiUsage.ts");
const askRoute = src("../app/api/ask/route.ts");
const proAskRoute = src("../app/api/pro-ask/route.ts");

function constant(name: string): number {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(aiUsage);
  if (!m) throw new Error(`${name} is not exported from aiUsage.ts`);
  return Number(m[1]);
}

describe("daily budgets", () => {
  it("gives the homeowner chat its own, much tighter allowance", () => {
    // Free is a taste: three chat questions a day. The tool routes run on a
    // separate, larger budget, so a document scan can neither spend a chat
    // question nor be paid for out of one.
    expect(constant("ASK_DAILY_FREE")).toBe(3);
    expect(constant("ASK_DAILY_PLUS")).toBe(15);
    expect(constant("ASK_DAILY_FREE")).toBeLessThan(constant("DAILY_LIMIT_FREE"));
    expect(constant("ASK_DAILY_PLUS")).toBeLessThan(constant("DAILY_LIMIT_PLUS"));
  });

  it("Plus is a real step up on both budgets", () => {
    expect(constant("ASK_DAILY_PLUS")).toBeGreaterThan(constant("ASK_DAILY_FREE"));
    expect(constant("DAILY_LIMIT_PLUS")).toBeGreaterThan(
      constant("DAILY_LIMIT_FREE")
    );
  });

  it("puts the trial between free and paid on both budgets", () => {
    // A trial that matched Plus would hand the full ceiling to any account
    // with a spare inbox (trials are free to start and free to start again);
    // one that matched free would demo nothing.
    expect(constant("ASK_DAILY_TRIAL")).toBe(8);
    expect(constant("ASK_DAILY_TRIAL")).toBeGreaterThan(
      constant("ASK_DAILY_FREE")
    );
    expect(constant("ASK_DAILY_TRIAL")).toBeLessThan(constant("ASK_DAILY_PLUS"));
    expect(constant("DAILY_LIMIT_TRIAL")).toBeGreaterThan(
      constant("DAILY_LIMIT_FREE")
    );
    expect(constant("DAILY_LIMIT_TRIAL")).toBeLessThan(
      constant("DAILY_LIMIT_PLUS")
    );
  });

  it("counts the chat in its own fixed-window bucket, not ai_usage", () => {
    expect(aiUsage).toContain("ask-day:${userId}");
    expect(aiUsage).toContain("rate_limit_hit");
    // The chat bucket must fail closed like every other counter here: a
    // broken counter is a paid model with no meter on it.
    expect(aiUsage).toContain("countAskUsage rate_limit_hit failed - failing CLOSED");
  });
});

describe("the homeowner chat route", () => {
  it("spends the chat bucket, never the tool budget", () => {
    expect(askRoute).toContain("countAskUsage");
    expect(askRoute).not.toContain("countAiUsage(");
  });

  it("keeps the burst and global ceilings in front of the model call", () => {
    expect(askRoute).toContain("countAiUsageWindow");
    expect(askRoute).toContain("overAiGlobalHourlyLimit");
  });

  it("refuses to answer for an account with no home on file", () => {
    // Ask Hearth's whole value is that it answers for THIS house, and a
    // throwaway account with no property is how you farm free questions.
    expect(askRoute).toContain("getProperties");
    expect(askRoute).toContain(
      "Add your home first and Ask Hearth can answer for it."
    );
    expect(askRoute).toContain('href: "/onboarding"');
  });

  it("still gates photos behind Plus", () => {
    expect(askRoute).toContain("newTurnHasImage");
    expect(askRoute).toContain("Photo questions are part of Hearth Plus.");
  });
});

describe("refusals say WHOSE limit was hit", () => {
  it("counters report a reason, not just a boolean", () => {
    // Three refusals used to look identical to a caller, so the chat told
    // everyone they had spent their three free questions and should buy Plus.
    // That is only true for one of them.
    expect(aiUsage).toContain("export type AiLimitReason");
    for (const reason of [
      '"user_daily"',
      '"user_burst"',
      '"global"',
      '"counter_unavailable"',
    ]) {
      expect(aiUsage).toContain(reason);
    }
    // Both counters hand the reason back.
    expect(aiUsage).toMatch(/reason: "user_daily"/);
    expect(aiUsage).toMatch(/reason: "counter_unavailable"/);
  });

  it("only the per-user daily cap gets the Plus pitch in the chat", () => {
    // The Plus copy sits behind a reason check, and the other refusals get
    // the neutral busy line with no upsell link attached.
    expect(askRoute).toContain('reason !== "user_daily"');
    expect(askRoute).toContain(
      "Ask Hearth is busy right now. Try again in a few minutes."
    );
    expect(proAskRoute).toContain('reason !== "user_daily"');
  });

  it("the tool routes translate the reason instead of flattening it", () => {
    // These four each hand-rolled a counter_unavailable ternary and flattened
    // everything else to "rate_limited"; the other seven had no branch at all.
    // Both halves now go through reasonToClientPayload (src/lib/aiReason.ts),
    // which is where the wording is asserted (src/lib/aiReason.test.ts).
    for (const rel of [
      "../app/api/insurance-packet/route.ts",
      "../app/api/tax-appeal/route.ts",
      "../app/api/draft-apply/route.ts",
      "../app/api/ingest-inspection/route.ts",
    ]) {
      const s = src(rel);
      expect(s).toContain("reasonToClientPayload(reason)");
      expect(s).not.toContain('reason === "counter_unavailable"');
    }
  });

  it("the walkthrough opts out of the tool burst window, not the daily cap", () => {
    // Up to 16 data-plate captures in one walk, against a 10-per-5-minutes
    // burst limit sized for one-off document scans: the limit meant to stop a
    // script was refusing the feature on the 11th photo, mid-walk.
    const route = src("../app/api/confirm-system/route.ts");
    expect(route).toMatch(/countAiUsage\([\s\S]*?burst: false/);
    // The daily cap and both owner-wide ceilings still run: only `burst` is
    // opted out, and `hourly` is left alone.
    expect(route).not.toContain("hourly: false");
  });
});

describe("a refused request must not spend a shared ceiling", () => {
  it("checks the per-user daily cap BEFORE the global hourly one", () => {
    // Both counters count as they check. With the global ceiling first, every
    // request from an already-capped account still bumped ai-global-hour and
    // shed load from people who had allowance left.
    for (const route of [askRoute, proAskRoute]) {
      const daily = route.search(/count(Ask|Ai)Usage\(/);
      const hourly = route.indexOf("overAiGlobalHourlyLimit()");
      expect(daily).toBeGreaterThan(-1);
      expect(hourly).toBeGreaterThan(-1);
      expect(daily).toBeLessThan(hourly);
    }
  });

  it("hands the question back when a ceiling above the user sheds it", () => {
    expect(aiUsage).toContain("export async function refundAskUsage");
    // Both paths that take a question without answering it refund: the
    // hourly shed, and a model call that threw.
    expect(askRoute.match(/refundAskUsage\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("gives the tool routes a burst limit and the hourly ceiling", () => {
    // Eleven tool routes had a daily cap and nothing else, so a script could
    // fire a document scan every 200ms all day.
    expect(aiUsage).toContain("AI_TOOL_BURST_LIMIT");
    expect(aiUsage).toContain('"ai-tool-burst"');
    // ...on their own bucket, never the chat's: rate_limits is keyed by
    // (bucket, window_start), so two window sizes on one bucket collide.
    expect(aiUsage).toContain("bucketPrefix");
  });
});

describe("the chat routes refuse an empty send before charging for it", () => {
  it("validates the newest turn ahead of every counter", () => {
    for (const route of [askRoute, proAskRoute]) {
      expect(route).toContain("hasAskableContent");
      expect(route).toContain("Type a question first.");
      const guard = route.indexOf("hasAskableContent(history)");
      const counted = route.search(/count(Ask|Ai)Usage\(/);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(counted);
    }
  });

  it("caps the request body and rate-limits before parsing it", () => {
    for (const route of [askRoute, proAskRoute]) {
      // The cap used to be a Content-Length check, which a chunked request
      // simply never sends: it read as 0 and the megabytes got buffered and
      // parsed anyway. readJsonBounded counts the bytes that actually arrive.
      expect(route).toContain("readJsonBounded(req, MAX_BODY_BYTES)");
      expect(route).not.toContain('req.headers.get("content-length")');
      expect(route).not.toContain("await req.json()");
      const burst = route.indexOf("countAiUsageWindow(authUser.id)");
      const parse = route.indexOf("readJsonBounded(req, MAX_BODY_BYTES)");
      expect(burst).toBeGreaterThan(-1);
      expect(burst).toBeLessThan(parse);
    }
  });

  it("puts a burst check in front of the body read on every AI tool route", () => {
    // The tool routes ran their burst check inside countAiUsage, which fires
    // only after the body has been buffered, parsed and validated - so the
    // one check meant to make a flood cheap to refuse was the check that
    // happened last. Each of these now pre-checks the same window with a
    // non-counting read (overToolBurst) before it reads a byte.
    const tools = [
      "analyze-quote",
      "confirm-system",
      "draft-apply",
      "draft-job",
      "extract-document",
      "ingest-inspection",
      "pro-past-jobs",
      "pro-tools",
    ];
    for (const name of tools) {
      const route = src(`../app/api/${name}/route.ts`);
      expect(route).toContain("overToolBurst");
      expect(route).not.toContain("await req.json()");
      const burst = route.search(/await overToolBurst\(/);
      const parse = route.indexOf("readJsonBounded(req, MAX_BODY_BYTES)");
      expect(burst).toBeGreaterThan(-1);
      expect(parse).toBeGreaterThan(-1);
      expect(burst).toBeLessThan(parse);
    }
  });

  it("keeps draft-job's photo-ownership check ahead of the usage counter", () => {
    // The burst pre-check goes in FRONT of the body read, but the rule it
    // must not disturb is that a photo which is not yours never spends a real
    // AI usage: the storage download stays ahead of countAiUsage.
    const route = src("../app/api/draft-job/route.ts");
    const download = route.indexOf('.from("home-photos")');
    const counted = route.indexOf("countAiUsage(user.id");
    expect(download).toBeGreaterThan(-1);
    expect(download).toBeLessThan(counted);
  });
});

describe("the chat's home context is bounded", () => {
  it("limits the rows and the characters that reach the prompt", () => {
    // Every one of these reads was unlimited, and the homeowner controls how
    // many rows they produce: 200 self-created reminders took a one-word
    // question from ~760 to ~33,700 input tokens, on every turn.
    expect(askRoute).toContain("MAX_CONTEXT_SYSTEMS");
    expect(askRoute).toContain("MAX_CONTEXT_TASKS");
    expect(askRoute).toContain(".slice(0, MAX_CONTEXT_CHARS)");
  });
});

describe("no Gemini remains in the AI surface", () => {
  it("the chat routes run on Claude", () => {
    for (const rel of ["../app/api/ask/route.ts", "../app/api/pro-ask/route.ts"]) {
      const s = src(rel);
      expect(s).toContain('from "@/lib/claude"');
      expect(s).not.toMatch(/gemini|GEMINI|generativelanguage/);
    }
  });
});

// ---------------------------------------------------------------------------
// The refunds, exercised for real against a fake table.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Store = {
  rows: Row[];
  // Fires immediately BEFORE each update statement, so a test can simulate a
  // concurrent request landing between the read and the write. That interleave
  // is the entire bug this rewrite fixes, and it is not reachable any other
  // way.
  onUpdate?: () => void;
  reads: number;
  updates: number;
};

// The thin slice of the PostgREST builder these two functions actually use:
// .select().eq()...maybeSingle() to read, and .update().eq()...select() to
// write. The update chain resolves to the rows it affected, which is how the
// compare-and-swap learns whether it won.
function fakeAdmin(store: Store) {
  return {
    from(_table: string) {
      const filters: [string, unknown][] = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      let descBy: string | null = null;

      const matches = () =>
        store.rows.filter((row) =>
          filters.every(([col, val]) => row[col] === val)
        );

      const ordered = () => {
        const rows = matches();
        return descBy
          ? [...rows].sort((a, b) =>
              String(b[descBy as string]).localeCompare(String(a[descBy as string]))
            )
          : rows;
      };

      const api = {
        select(_cols?: string) {
          if (mode === "update") {
            // Terminal on an update: apply the patch to whatever matched.
            store.updates += 1;
            const hit = matches();
            for (const row of hit) Object.assign(row, patch);
            return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null });
          }
          return api;
        },
        update(next: Row) {
          mode = "update";
          patch = next;
          store.onUpdate?.();
          return api;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return api;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          if (opts?.ascending === false) descBy = col;
          return api;
        },
        limit(_n: number) {
          return api;
        },
        maybeSingle() {
          store.reads += 1;
          const hit = ordered()[0];
          // A COPY, deliberately. PostgREST hands back a snapshot over the
          // wire, and handing back the live object instead would let the
          // caller's remembered count follow a concurrent write - which is
          // exactly the race these tests exist to reproduce.
          return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
        },
      };
      return api;
    },
  };
}

function store(rows: Row[]): Store {
  return { rows, reads: 0, updates: 0 };
}

const USER = "user-1";
const BUCKET = `ask-day:${USER}`;
const WINDOW = "2026-08-21T00:00:00.000Z";

beforeEach(() => {
  currentAdmin = null;
});

describe("refundAskUsage is a compare-and-swap", () => {
  it("hands back exactly one question", async () => {
    const s = store([{ bucket: BUCKET, window_start: WINDOW, count: 3 }]);
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, WINDOW);
    expect(s.rows[0].count).toBe(2);
    expect(s.updates).toBe(1);
  });

  // THE BUG. The old code read the count and wrote back count-1 with no
  // condition, so an increment that landed in between was simply erased: two
  // tabs asking at once plus one failing request handed back a question that
  // had already been re-spent, and a caller who could arrange that reliably
  // had no daily cap left at all.
  it("does not clobber an increment that lands between the read and the write", async () => {
    const s = store([{ bucket: BUCKET, window_start: WINDOW, count: 3 }]);
    let bumped = false;
    s.onUpdate = () => {
      // Another request spends a question just as this refund goes to write.
      if (!bumped) {
        bumped = true;
        s.rows[0].count = 4;
      }
    };
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, WINDOW);
    // 3 read, bumped to 4 by the other request, refunded once: 3. The blind
    // write produced 2, silently giving away the question the other request
    // had just spent.
    expect(s.rows[0].count).toBe(3);
    // It lost the first swap and had to re-read to get there.
    expect(s.reads).toBe(2);
  });

  it("gives up rather than spinning when every attempt loses", async () => {
    const s = store([{ bucket: BUCKET, window_start: WINDOW, count: 5 }]);
    // A writer that moves the count on EVERY attempt: the swap can never win.
    s.onUpdate = () => {
      s.rows[0].count = (s.rows[0].count as number) + 1;
    };
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, WINDOW);
    // Three attempts, then it stops. Failing this way charges the person for
    // a question they did not get, which is the safe direction and one they
    // can retry out of; spinning forever would hold the request open.
    expect(s.reads).toBe(3);
    expect(s.updates).toBe(3);
  });

  it("never drives a count below zero", async () => {
    const s = store([{ bucket: BUCKET, window_start: WINDOW, count: 0 }]);
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, WINDOW);
    expect(s.rows[0].count).toBe(0);
    expect(s.updates).toBe(0);
  });

  it("does nothing when the window has no row", async () => {
    const s = store([]);
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, WINDOW);
    expect(s.updates).toBe(0);
  });

  // The midnight case. The chat's window is a fixed 24 hour block, so a
  // request that starts at 23:59:59 and fails at 00:00:01 would compute
  // TOMORROW's window on the way out and refund a row it was never charged
  // in, leaving the question spent. countAskUsage hands back the window it
  // charged and the route passes it here.
  it("refunds the window it was charged in, not the current one", async () => {
    const yesterday = "2026-08-20T00:00:00.000Z";
    const s = store([
      { bucket: BUCKET, window_start: yesterday, count: 3 },
      { bucket: BUCKET, window_start: WINDOW, count: 1 },
    ]);
    currentAdmin = fakeAdmin(s);
    const { refundAskUsage } = await import("./aiUsage");
    await refundAskUsage(USER, yesterday);
    expect(s.rows[0].count).toBe(2);
    expect(s.rows[1].count).toBe(1);
  });
});

describe("refundAiUsage", () => {
  // bump_ai_usage clamps its delta with greatest(coalesce(p_delta, 1), 0)
  // (migration 0072), so calling it with -1 is a no-op, not a decrement. Hence
  // the same compare-and-swap, straight on the row.
  it("hands back one tool usage from the row that was charged", async () => {
    const s = store([
      { user_id: USER, usage_date: "2026-08-20", count: 9 },
      { user_id: USER, usage_date: "2026-08-21", count: 4 },
    ]);
    currentAdmin = fakeAdmin(s);
    const { refundAiUsage } = await import("./aiUsage");
    await refundAiUsage(USER);
    // The newest row, which is the one bump_ai_usage just wrote. Yesterday's
    // is left alone.
    expect(s.rows[1].count).toBe(3);
    expect(s.rows[0].count).toBe(9);
  });

  it("does not clobber a concurrent charge either", async () => {
    const s = store([{ user_id: USER, usage_date: "2026-08-21", count: 4 }]);
    let bumped = false;
    s.onUpdate = () => {
      if (!bumped) {
        bumped = true;
        s.rows[0].count = 5;
      }
    };
    currentAdmin = fakeAdmin(s);
    const { refundAiUsage } = await import("./aiUsage");
    await refundAiUsage(USER);
    expect(s.rows[0].count).toBe(4);
  });

  it("never drives a count below zero", async () => {
    const s = store([{ user_id: USER, usage_date: "2026-08-21", count: 0 }]);
    currentAdmin = fakeAdmin(s);
    const { refundAiUsage } = await import("./aiUsage");
    await refundAiUsage(USER);
    expect(s.rows[0].count).toBe(0);
    expect(s.updates).toBe(0);
  });
});

describe("the pro chat refunds what it never answered", () => {
  it("hands the question back on every path that takes one without answering", () => {
    // /api/ask has always done this; /api/pro-ask had no refund path at all,
    // so a pro shed by the hourly ceiling, or a model call that threw, quietly
    // spent one of their daily allowance for nothing.
    //
    expect(aiUsage).toContain("export async function refundAiUsage");
    const shed = proAskRoute.indexOf("overAiGlobalHourlyLimit()");
    const refundAfterShed = proAskRoute.indexOf("refundAiUsage(", shed);
    expect(refundAfterShed).toBeGreaterThan(shed);
    // Everything after the stream opens refunds through one idempotent helper,
    // so two failures on the way out cannot hand back two questions for one
    // charge - the mirror image of charging twice.
    expect(proAskRoute).toContain("const refundOnce = async ()");
    expect(proAskRoute).toContain("if (refunded) return;");
  });
});

// A reply that arrives with NO TEXT is the shape the checker hit in the local
// production build: the model call did not throw, so nothing above catches it,
// the stream just ended empty. The homeowner read "Sorry, I couldn't generate
// an answer" and still watched one of three daily questions disappear into it.
// Both chat routes now refund that, and the homeowner one sends the refunded
// meter back with the reply so the count on screen matches the counter in the
// database.
describe("an empty reply is refunded like any other failure", () => {
  it("refunds on the empty-text branch in both chat routes", () => {
    for (const route of [askRoute, proAskRoute]) {
      // The empty branch exists, and refunds before it emits anything.
      expect(route).toContain("if (!text) {");
      const emptyAt = route.indexOf("if (!text) {");
      const refundAt = route.indexOf("await refundOnce();", emptyAt);
      const emitAt = route.indexOf("emit(", emptyAt);
      expect(refundAt).toBeGreaterThan(emptyAt);
      expect(refundAt).toBeLessThan(emitAt);
    }
  });

  it("sends the REFUNDED meter with that reply, not the spent one", () => {
    // refundedRemaining is freeRemaining + 1: the meter has to agree with the
    // counter, or the chat shows a question spent that was just handed back.
    expect(askRoute).toContain(
      "const refundedRemaining = freeRemaining === null ? null : freeRemaining + 1;"
    );
    const emptyAt = askRoute.indexOf("if (!text) {");
    const doneAt = askRoute.indexOf("encodeDone({", emptyAt);
    const meterAt = askRoute.indexOf("freeRemaining: refundedRemaining", doneAt);
    expect(meterAt).toBeGreaterThan(doneAt);
    // ...and it is close by: the same encodeDone call, not one further down.
    expect(meterAt - doneAt).toBeLessThan(300);
  });

  it("also sends the refunded meter on a pre-stream throw", () => {
    // streamText throwing before the request opens (a bad payload, a 429 from
    // Anthropic) is an ordinary JSON reply, and it has always refunded through
    // failedAnswer. This pins the meter that rides with it.
    const preStream = askRoute.indexOf("answer: await failedAnswer(e),");
    expect(preStream).toBeGreaterThan(-1);
    expect(askRoute.slice(preStream, preStream + 200)).toContain(
      "freeRemaining: refundedRemaining"
    );
  });

  it("refunds at most once per request", () => {
    // Three paths can reach a refund after the stream opens (a thrown call, an
    // empty reply, an abort before the first delta). Two of them firing for one
    // charge would hand back two questions.
    expect(askRoute).toContain("const refundOnce = async ()");
    expect(askRoute).toContain("if (refunded) return;");
    // failedAnswer goes through it too, rather than calling the refund direct.
    const failedAt = askRoute.indexOf("const failedAnswer = async (");
    expect(askRoute.slice(failedAt, failedAt + 300)).toContain(
      "await refundOnce();"
    );
  });
});

// An abort before the first delta gets its question back, because nothing was
// delivered. That is also the one farmable thing on either chat route: fire a
// question, hang up the instant the headers land, and the daily counter goes
// up and straight back down again while a paid model call was still opened.
describe("the early-abort refund is metered", () => {
  it("counts early aborts in their own bucket, capped per hour", () => {
    expect(aiUsage).toContain("export async function allowAbortRefund");
    // Its OWN bucket: never the burst or daily counters, which would let an
    // abort spend or shed something it has no business touching.
    expect(aiUsage).toContain("`ask-abort:${userId}`");
    expect(aiUsage).toContain("export const ASK_ABORT_REFUND_LIMIT");
    expect(aiUsage).toContain("export const ASK_ABORT_REFUND_WINDOW_SECONDS");
  });

  it("gates BOTH chat routes' abort refunds on it", () => {
    for (const route of [askRoute, proAskRoute]) {
      expect(route).toContain("allowAbortRefund(authUser.id)");
      // The refund is inside the `!sentAny` branch: once deltas have gone out,
      // the answer was delivered and the question stays spent, metered or not.
      expect(route).toMatch(/if \(!sentAny && \(await allowAbortRefund\(/);
    }
  });
});

// Which allowance a caller gets is a three-way answer, not a boolean: free,
// on the trial, or paying. hasPlus() collapses the last two, which is right
// for "may they use this" and wrong for "how much may they spend" - a trial
// costs nothing to start and nothing to start again from a fresh email. These
// are the pure resolvers the counters run on, so the three-way decision is
// testable without a database.
describe("which daily allowance a tier gets", () => {
  it("gives the chat three numbers, not two", async () => {
    const { askDailyLimitFor, ASK_DAILY_FREE, ASK_DAILY_TRIAL, ASK_DAILY_PLUS } =
      await import("./aiUsage");
    expect(askDailyLimitFor("free")).toBe(ASK_DAILY_FREE);
    expect(askDailyLimitFor("trialing")).toBe(ASK_DAILY_TRIAL);
    expect(askDailyLimitFor("paid")).toBe(ASK_DAILY_PLUS);
  });

  it("gives the tool budget three numbers too", async () => {
    const {
      toolDailyLimitFor,
      DAILY_LIMIT_FREE,
      DAILY_LIMIT_TRIAL,
      DAILY_LIMIT_PLUS,
    } = await import("./aiUsage");
    expect(toolDailyLimitFor("free")).toBe(DAILY_LIMIT_FREE);
    expect(toolDailyLimitFor("trialing")).toBe(DAILY_LIMIT_TRIAL);
    expect(toolDailyLimitFor("paid")).toBe(DAILY_LIMIT_PLUS);
  });

  it("never hands a trial the paid ceiling", async () => {
    const { askDailyLimitFor, toolDailyLimitFor } = await import("./aiUsage");
    expect(askDailyLimitFor("trialing")).toBeLessThan(askDailyLimitFor("paid"));
    expect(askDailyLimitFor("trialing")).toBeGreaterThan(
      askDailyLimitFor("free")
    );
    expect(toolDailyLimitFor("trialing")).toBeLessThan(
      toolDailyLimitFor("paid")
    );
    expect(toolDailyLimitFor("trialing")).toBeGreaterThan(
      toolDailyLimitFor("free")
    );
  });

  it("keeps the old boolean call sites meaning exactly what they meant", async () => {
    // Every pro-side route still passes a boolean: true was always "the Plus
    // ceiling", and it still is. Nothing silently changes under them.
    const { toAiTier } = await import("./aiUsage");
    expect(toAiTier(true)).toBe("paid");
    expect(toAiTier(false)).toBe("free");
    expect(toAiTier("trialing")).toBe("trialing");
    expect(toAiTier("free")).toBe("free");
    expect(toAiTier("paid")).toBe("paid");
  });
});
