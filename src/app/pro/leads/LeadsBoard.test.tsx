// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The board's interactive children reach server actions (ApplyJobButton ->
// ./actions, JobStatusSelect -> the same file), which cannot be imported in a
// test process. Stubs keep this test on the one thing it is about: the sort.
vi.mock("../ApplyJobButton", () => ({ default: () => null }));
vi.mock("../DirectRequestCard", () => ({ default: () => null }));
vi.mock("../JobStatusSelect", () => ({ default: () => null }));
vi.mock("../JobPhotoStrip", () => ({ default: () => null }));
vi.mock("@/components/OpenChatButton", () => ({ default: () => null }));

import LeadsBoard, { type OpenJobVM } from "./LeadsBoard";
import { MAX_APPLICANTS_PER_JOB } from "@/lib/constants";

// A card carries a lot of resolved display data; only the three fields the
// sort and this test read have to be real.
function job(
  id: string,
  feeCents: number,
  off: number,
  opts: { discountKind?: OpenJobVM["discountKind"]; memberQuoteStr?: string | null } = {}
): OpenJobVM {
  return {
    id,
    categoryLabel: `Job ${id}`,
    city: null,
    severity: null,
    ownershipVerified: false,
    feeGlance: `$${feeCents / 100}`,
    glanceLine2: "",
    feeStr: `$${feeCents / 100}`,
    baseStr: `$${feeCents / 100}`,
    off,
    introPrice: false,
    discountKind: opts.discountKind ?? null,
    memberQuoteStr: opts.memberQuoteStr ?? null,
    description: null,
    photoUrls: [],
    budgetLabel: null,
    chips: [],
    scope: [],
    hasPlansPermits: false,
    postedAgoLabel: null,
    timingLabel: null,
    spots: 0,
    full: false,
    conflict: null,
    feeCents,
    canAfford: true,
    billingHref: "/pro/billing",
  };
}

// Newest first, the order the server hands over.
const openJobs = [job("a", 4500, 0), job("b", 1200, 40), job("d", 900, 10)];

// Full LeadsBoard props with just the open-jobs list swapped in, for tests
// that only care about one card's own fields (the applicant count, the
// glance line) rather than the sort.
function boardProps(jobs: OpenJobVM[]) {
  return {
    lowBalance: false,
    directRequests: [],
    balance: 100,
    hasPaidMajor: false,
    openJobs: jobs,
    sort: "new",
    hasApplied: false,
    isProMember: false,
    proTrialEligible: false,
    assigned: [],
    pendingApps: [],
    declinedApps: [],
  };
}

function renderBoard(sort: string) {
  return render(
    <LeadsBoard
      lowBalance={false}
      directRequests={[]}
      balance={100}
      hasPaidMajor={false}
      openJobs={openJobs}
      sort={sort}
      hasApplied={false}
      isProMember={false}
      proTrialEligible={false}
      assigned={[]}
      pendingApps={[]}
      declinedApps={[]}
    />
  );
}

// The rendered order of the open-job cards, read off the category label.
function order(): string[] {
  return screen
    .getAllByText(/^Job [abd]$/)
    .map((el) => el.textContent!.replace("Job ", ""))
    // Each card prints the label twice (a phone glance line and the desktop
    // row), so collapse to one entry per card while keeping the order.
    .filter((id, i, all) => all.indexOf(id) === i);
}

describe("LeadsBoard sort", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/pro/leads");
  });

  it("renders the order the URL asked for, without a click", () => {
    renderBoard("fee");
    expect(order()).toEqual(["d", "b", "a"]);
  });

  it("re-sorts on the client when a button is tapped", () => {
    renderBoard("new");
    expect(order()).toEqual(["a", "b", "d"]);

    fireEvent.click(screen.getByRole("button", { name: "Cheapest fee" }));
    expect(order()).toEqual(["d", "b", "a"]);

    fireEvent.click(screen.getByRole("button", { name: "Biggest deal" }));
    expect(order()).toEqual(["b", "d", "a"]);

    // Newest is the array's own order, so it comes back with no request.
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(order()).toEqual(["a", "b", "d"]);
  });

  it("writes the choice into the URL without navigating", () => {
    renderBoard("new");
    fireEvent.click(screen.getByRole("button", { name: "Cheapest fee" }));
    expect(window.location.pathname + window.location.search).toBe(
      "/pro/leads?sort=fee"
    );
    // Back to the default drops the parameter rather than leaving ?sort=new.
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(window.location.pathname + window.location.search).toBe(
      "/pro/leads"
    );
  });

  it("marks the active button pressed for screen readers", () => {
    renderBoard("new");
    expect(screen.getByRole("button", { name: "Newest" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Cheapest fee" }));
    expect(screen.getByRole("button", { name: "Cheapest fee" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Newest" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});

// Migration 0149: Hearth Pro members get 10% off every lead fee, never
// stacked with the aging markdown. One card, one discount, one label.
describe("LeadsBoard: member vs aging discount labels (0149)", () => {
  afterEach(() => cleanup());

  it('shows the Pro chip and "with Pro" on a member-discounted card, never the aging label', () => {
    render(
      <LeadsBoard
        lowBalance={false}
        directRequests={[]}
        balance={100}
        hasPaidMajor={false}
        openJobs={[job("m", 4500, 10, { discountKind: "member" })]}
        sort="new"
        hasApplied={false}
        isProMember={true}
        proTrialEligible={false}
        assigned={[]}
        pendingApps={[]}
        declinedApps={[]}
      />
    );
    // The desktop row's chip and the "with Pro" suffix on the fee.
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
    expect(screen.getByText(/with Pro/)).toBeInTheDocument();
    // Never the aging wording on the same card.
    expect(screen.queryByText(/% off, posted/)).not.toBeInTheDocument();
  });

  it("shows the aging label on an aging-discounted card, never a Pro chip", () => {
    render(
      <LeadsBoard
        lowBalance={false}
        directRequests={[]}
        balance={100}
        hasPaidMajor={false}
        openJobs={[
          {
            ...job("a", 3400, 30, { discountKind: "aging" }),
            postedAgoLabel: "Posted 8 days ago",
          },
        ]}
        sort="new"
        hasApplied={false}
        isProMember={false}
        proTrialEligible={false}
        assigned={[]}
        pendingApps={[]}
        declinedApps={[]}
      />
    );
    expect(screen.getByText(/30% off, posted 8 days ago/)).toBeInTheDocument();
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
  });

  it('shows the honest "Pro members pay $X" quiet line for a non-member, linking to the upsell', () => {
    render(
      <LeadsBoard
        lowBalance={false}
        directRequests={[]}
        balance={100}
        hasPaidMajor={false}
        openJobs={[job("q", 4500, 0, { memberQuoteStr: "$40.50" })]}
        sort="new"
        hasApplied={false}
        isProMember={false}
        proTrialEligible={false}
        assigned={[]}
        pendingApps={[]}
        declinedApps={[]}
      />
    );
    const link = screen.getByRole("link", { name: /Pro members pay \$40.50/ });
    expect(link).toHaveAttribute("href", "/pro/plus?reason=leads");
  });

  it("shows no quiet line when membership would not have beaten this card's price", () => {
    render(
      <LeadsBoard
        lowBalance={false}
        directRequests={[]}
        balance={100}
        hasPaidMajor={false}
        openJobs={[job("n", 4500, 30, { discountKind: "aging", memberQuoteStr: null })]}
        sort="new"
        hasApplied={false}
        isProMember={false}
        proTrialEligible={false}
        assigned={[]}
        pendingApps={[]}
        declinedApps={[]}
      />
    );
    expect(screen.queryByText(/Pro members pay/)).not.toBeInTheDocument();
  });
});

// CR5 remove #3: "X of N spots taken" read as the same blind-bidding
// pressure pros resent about Angi/HomeAdvisor. Neutral transparency instead,
// red only once the job is actually full.
describe("LeadsBoard: applicant count reads as transparency, not a countdown", () => {
  afterEach(() => cleanup());

  it("shows a neutral, plain-English count below the cap", () => {
    render(<LeadsBoard {...boardProps([{ ...job("a", 4500, 0), spots: 2, full: false }])} />);
    expect(screen.getByText("2 pros have applied")).toBeInTheDocument();
    expect(screen.queryByText(/of 3 spots taken/)).not.toBeInTheDocument();
  });

  it("uses singular wording for exactly one applicant", () => {
    render(<LeadsBoard {...boardProps([{ ...job("a", 4500, 0), spots: 1, full: false }])} />);
    expect(screen.getByText("1 pro has applied")).toBeInTheDocument();
  });

  it("reads Full: N pros applied, in red, once the job is full", () => {
    render(<LeadsBoard {...boardProps([{ ...job("a", 4500, 0), spots: 3, full: true }])} />);
    const full = screen.getByText(`Full: ${MAX_APPLICANTS_PER_JOB} pros applied`);
    expect(full).toBeInTheDocument();
    expect(full).toHaveClass("text-red-600");
  });
});

// CR3#6: the phone-only timing/city line sat at the 12px floor.
describe("LeadsBoard: phone glance line reads at 14px, not 12px", () => {
  afterEach(() => cleanup());

  it("renders glanceLine2 at text-sm, not text-xs", () => {
    render(
      <LeadsBoard
        {...boardProps([{ ...job("a", 4500, 0), glanceLine2: "This week · Anaheim" }])}
      />
    );
    const line = screen.getByText("This week · Anaheim");
    expect(line).toHaveClass("text-sm");
    expect(line).not.toHaveClass("text-xs");
  });
});

// MED-2: HomeView.tsx's "Active jobs" stat links to `${PRO_LEADS_HREF}#your-jobs`
// (the count it shows is computed from the same `assigned` list this section
// renders - see activeCount in page.tsx), so the section that count actually
// describes has to carry that id for the link to land anywhere.
describe("LeadsBoard: Your jobs section carries the #your-jobs anchor", () => {
  afterEach(() => cleanup());

  it("has id=your-jobs on the section rendering the assigned jobs heading", () => {
    render(<LeadsBoard {...boardProps([])} />);
    const heading = screen.getByRole("heading", { name: /Your jobs/ });
    expect(heading.closest("section")).toHaveAttribute("id", "your-jobs");
  });
});
