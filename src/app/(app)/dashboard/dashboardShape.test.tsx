// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";

// Vitest globals are off in this repo (see vitest.config.ts), so
// testing-library's usual auto-cleanup-after-each never wires itself up;
// without this, each test's render() output piles up in the same jsdom
// document and later getByTestId calls see duplicates from earlier tests.
afterEach(() => cleanup());

// This dashboard rewrite flattened four stat cards down to one-number,
// one-label tiles that are each a single tap target, and folded "This
// month"'s reminder/warranty detail behind one disclosure that only starts
// open on ?plan=open or a first visit (?welcome=1). Both properties are easy
// to accidentally regress (a stray inner <Link>, a details left open by
// default), so they're covered directly against the real page rather than a
// hand-rolled fixture.
//
// Everything below is mocked EXCEPT the markup this task touched: page.tsx
// itself, and the pure helpers it calls (@/lib/health, @/lib/constants,
// @/lib/homeValue, @/lib/energy, @/lib/maintenancePlan). Every client
// subcomponent that fetches, reads localStorage, or needs a Next.js router
// context is replaced with a inert stub so the page can render in plain
// jsdom with no network.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mutable fixture the Supabase stub below reads home_systems from. Hoisted so
// it exists before page.tsx (and therefore the mocked module) is imported;
// most tests want an empty home, the "Your systems" ones fill it in.
const fixtures = vi.hoisted(() => ({
  systems: [] as Record<string, unknown>[],
  // maintenance_tasks. Empty for most tests (no plan built yet); the
  // maintenance-plan CTA tests fill it with a real plan-schedule title so
  // hasOpenPlan flips true.
  tasks: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/subscription", () => ({
  hasPlus: vi.fn(async () => true),
}));

vi.mock("@/lib/auth", () => ({
  getUser: vi.fn(async () => null),
}));

const property = {
  id: "prop-1",
  address_line1: "123 Main St",
  zip: "12345",
  state: "CA",
  sqft: 1500,
  year_built: 1990,
  purchase_date: "2020-01-01",
  ownership_status: "unverified",
  purchase_price: 300000,
  mortgage_balance: 200000,
  market_value: 350000,
  market_value_low: 340000,
  market_value_high: 360000,
};

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => property),
}));

// Chainable Supabase query-builder stub: every filter method returns itself,
// and the object is thenable (so `await` / Promise.all resolve it) to a fixed
// { data } payload. Good enough for a page whose only read of the client is
// a batch of independent .from(table).select()... queries.
function chain(data: unknown) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    in: () => obj,
    not: () => obj,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({ data, error: null }),
  };
  return obj;
}

// One open issue so the briefing has a real, actionable row to assert on.
// With every table empty the briefing falls back to its single "Nothing urgent
// right now" line, which carries no href by design and so exercises none of the
// tap-target markup below.
const openIssue = {
  id: "issue-1",
  system_id: null,
  category: "plumbing",
  severity: "urgent",
  description: "Leaking under the sink",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) =>
      chain(
        table === "issues"
          ? [openIssue]
          : table === "home_systems"
            ? fixtures.systems
            : table === "maintenance_tasks"
              ? fixtures.tasks
              : []
      ),
  })),
}));

vi.mock("./actions", () => ({
  generateMaintenancePlanAction: vi.fn(),
}));

vi.mock("../profile/actions", () => ({
  addSystemFormAction: vi.fn(),
}));

vi.mock("../profile/SystemForm", () => ({
  default: () => null,
}));

vi.mock("../profile/SystemRow", () => ({
  default: () => null,
}));

vi.mock("@/components/SeasonalChecklist", () => ({
  default: () => null,
}));

vi.mock("./ReminderItem", () => ({
  default: () => null,
}));

vi.mock("./WalkthroughNudge", () => ({
  default: () => null,
}));

vi.mock("@/components/HomeAlerts", () => ({
  default: () => null,
}));

vi.mock("@/components/WeatherStrip", () => ({
  default: () => null,
}));

vi.mock("../value/ValueAutoFetch", () => ({
  default: () => null,
}));

import HomePage from "./page";
// Real helper, not a stub: the page decides "a plan exists" by matching open
// task titles against this set, so the fixture has to use a title from it.
import { planTitles } from "@/lib/maintenancePlan";

async function renderDashboard(searchParams: Record<string, string> = {}) {
  const element = await HomePage({
    searchParams: Promise.resolve(searchParams),
  });
  return render(element as React.ReactElement);
}

describe("dashboard stat grid", () => {
  it("renders every stat card as a single tap target with no anchor nested inside another", async () => {
    const { container } = await renderDashboard();
    const anchors = Array.from(container.querySelectorAll("a"));
    // Sanity: the stat grid actually rendered some links (Home value, Energy,
    // Open jobs are all card-links).
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.querySelector("a")).toBeNull();
    }
  });

  // Phone declutter: the home page was 3-4 screens of scroll, so "Open jobs"
  // (a jobs concept, and the count now sits at the top of /contractors) and
  // "Home value" (already a permanent entry in the phone Tools sheet) are
  // hidden below sm. Both stay in the DOM and keep their data - desktop still
  // renders the full four-card grid - so this asserts the class, not the
  // hiding: jsdom does not evaluate media queries, and the visual result is a
  // viewport concern outside this test's reach.
  it("hides the Open jobs and Home value cards on phone only", async () => {
    const { container } = await renderDashboard();
    const anchors = Array.from(container.querySelectorAll("a"));
    const openJobs = anchors.find((a) => a.textContent?.includes("Open jobs"));
    const homeValue = anchors.find((a) => a.textContent?.includes("Home value"));
    expect(openJobs).toBeTruthy();
    expect(homeValue).toBeTruthy();
    expect(openJobs!.classList.contains("max-sm:hidden")).toBe(true);
    expect(openJobs!.classList.contains("card-link")).toBe(true);
    expect(homeValue!.classList.contains("max-sm:hidden")).toBe(true);
    expect(homeValue!.classList.contains("card-link")).toBe(true);
  });

  // Same declutter: twenty-one project chips wrap to about seven rows at
  // 390px. They live at the top of /contractors on phone now (see
  // contractors/ProjectChips), and stay here on desktop.
  it("hides the project chips section on phone only", async () => {
    const { container } = await renderDashboard();
    const heading = Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent === "Thinking about a project?"
    );
    expect(heading).toBeTruthy();
    expect(heading!.parentElement!.classList.contains("max-sm:hidden")).toBe(true);
  });
});

// The briefing used to end each line with a literal "→" glued to the last word
// of a wrapped sentence: nothing to aim at, and nothing to visually scan for.
// Each actionable item is one full-width link row now, at every width.
describe("Hearth's briefing rows", () => {
  it("renders an actionable item as a single link row that clears 44px", async () => {
    const { container } = await renderDashboard();
    const row = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Find a pro")
    );
    expect(row).toBeTruthy();
    expect(row!.getAttribute("href")).toContain("/contractors?category=plumbing");
    expect(row!.classList.contains("min-h-11")).toBe(true);
    expect(row!.classList.contains("flex")).toBe(true);
    // A real ChevronRight icon, not the old text arrow.
    expect(row!.querySelector("svg")).toBeTruthy();
    expect(row!.textContent).not.toContain("→");
    // The whole sentence is inside the tap target, not just the CTA words.
    expect(row!.textContent).toContain("issue needs attention");
  });
});

// Ask Hearth has one entry point now, the pinned row at the top of the Messages
// tab. The dashboard used to carry a phone-only door to it as well; scattering
// doors is what made the assistant read as the whole product.
describe("Ask Hearth entry point", () => {
  it("carries no Ask Hearth door of its own", async () => {
    const { queryByTestId, container } = await renderDashboard();
    expect(queryByTestId("ask-hearth-card")).toBeNull();
    const askLinks = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/ask"
    );
    expect(askLinks).toHaveLength(0);
  });
});

// Phone: the stats grid is the Home Health Score and nothing else. Open jobs,
// Home value, and Energy this season each duplicate somewhere one tap away and
// made the home page a long scroll on a 390px screen. All three are still in
// the DOM for desktop, behind max-sm:hidden.
describe("Stat cards on a phone", () => {
  it("hides the energy card below sm and keeps the health score", async () => {
    const { container } = await renderDashboard();
    const energy = Array.from(container.querySelectorAll("p")).find(
      (p) => p.textContent === "Energy this season"
    );
    expect(energy).toBeTruthy();
    expect(energy!.closest("div.card")!.classList.contains("max-sm:hidden")).toBe(
      true
    );
    const score = Array.from(container.querySelectorAll("p")).find(
      (p) => p.textContent === "Home Health Score"
    );
    expect(score).toBeTruthy();
    expect(score!.closest("div.card-hero")!.className).not.toContain(
      "max-sm:hidden"
    );
  });
});

// Seven system cards is several screens of scroll on a 390px phone, at the
// very bottom of the page. Below sm the list stops after three with a button
// that expands it in place; desktop still renders every row in one <ul>.
describe("Your systems on a phone", () => {
  const SEVEN = [
    "roof",
    "hvac",
    "water_heater",
    "windows",
    "siding",
    "gutters",
    "foundation",
  ].map((system_type, i) => ({
    id: `sys-${i}`,
    property_id: "prop-1",
    system_type,
    install_year: 2015,
    condition_rating: 4,
    material_or_model: null,
    confirmed_at: "2026-01-01",
    created_at: "2026-01-01",
  }));

  afterEach(() => {
    fixtures.systems = [];
  });

  it("hides every row past the third below sm, and offers to show the rest", async () => {
    fixtures.systems = SEVEN;
    const { container, getByRole } = await renderDashboard();

    const list = container.querySelector("#systems ul");
    expect(list).toBeTruthy();
    // The rows are all rendered; CSS hides the tail until asked for.
    expect(list!.className).toContain("max-sm:[&>*:nth-child(n+4)]:hidden");

    const button = getByRole("button", { name: /See all 7 systems/ });
    expect(button.className).toContain("sm:hidden");
    expect(button.className).toContain("min-h-11");
  });

  it("leaves a short list alone - no collapse, no button", async () => {
    fixtures.systems = SEVEN.slice(0, 3);
    const { container, queryByRole } = await renderDashboard();

    const list = container.querySelector("#systems ul");
    expect(list!.className).not.toContain("nth-child");
    expect(queryByRole("button", { name: /See all/ })).toBeNull();
  });
});

describe("This month task disclosure", () => {
  // The owner's rule: open on the first visit and on the thousandth, and only
  // closed if the reader closed it themselves. So the server render is now
  // unconditionally open, and the remembered close is applied on the client by
  // RememberedDetails (see its own test for that half).
  it("is open by default on every visit", async () => {
    const { getByTestId } = await renderDashboard();
    const details = getByTestId("this-month-tasks");
    expect(details).toHaveAttribute("open");
  });

  it("stays open with ?plan=open", async () => {
    const { getByTestId } = await renderDashboard({ plan: "open" });
    const details = getByTestId("this-month-tasks");
    expect(details).toHaveAttribute("open");
  });

  it("stays open on a first visit (?welcome=1)", async () => {
    const { getByTestId } = await renderDashboard({ welcome: "1" });
    const details = getByTestId("this-month-tasks");
    expect(details).toHaveAttribute("open");
  });
});

describe("Maintenance plan CTA", () => {
  // The owner's complaint: pressing "Get my maintenance plan" made the button
  // disappear, so there was nothing to press again and no way to top the plan
  // up later. A member with a plan now keeps a real button in the same spot.
  const planTitle = [...planTitles()][0];

  afterEach(() => {
    fixtures.tasks = [];
  });

  it("offers the build button while no plan exists", async () => {
    fixtures.tasks = [];
    const { getByRole, queryByRole } = await renderDashboard();
    expect(getByRole("button", { name: "Build my plan" })).toBeInTheDocument();
    expect(
      queryByRole("button", { name: "Update my maintenance plan" })
    ).toBeNull();
  });

  it("keeps a button in the same spot once the plan exists", async () => {
    fixtures.tasks = [
      { id: "t-1", title: planTitle, status: "open", due_date: null },
    ];
    const { getByRole } = await renderDashboard();
    // "View my plan" is still the primary, and the action that builds the plan
    // comes back as a secondary rather than vanishing.
    expect(getByRole("link", { name: "View my plan" })).toBeInTheDocument();
    expect(
      getByRole("button", { name: "Update my maintenance plan" })
    ).toBeInTheDocument();
  });
});
