// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Vitest globals are off in this repo (see vitest.config.ts), so
// testing-library's usual auto-cleanup-after-each never wires itself up.
afterEach(() => cleanup());

// The forecast page grew four things that a free reader and a member must see
// DIFFERENTLY: the push-it-out step under each system, the repair reserve, the
// rebate lines, and the early-quotes card. The gating is the part that is easy
// to regress (one misplaced brace and a free reader gets the paid feature, or a
// member loses it), so it is tested against the real page rather than a
// hand-rolled fixture. Everything the page talks to is stubbed; every pure
// helper it calls is real.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

const fixtures = vi.hoisted(() => ({
  plus: true,
  reserveCents: null as number | null,
}));

vi.mock("@/lib/subscription", () => ({
  hasPlus: vi.fn(async () => fixtures.plus),
}));

const property = {
  id: "prop-1",
  address_line1: "123 Main St",
  state: "CA",
  zip: "92602",
  sqft: 1800,
  year_built: 1994,
};

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => property),
}));

// A water heater near the end of its life (high consequence, so it lands in the
// early-quotes card and has a curated flush step), an HVAC (which carries the
// heat pump rebate line), and a fence far out (which has a step but no rebate).
const systems = [
  {
    id: "sys-wh",
    property_id: "prop-1",
    system_type: "water_heater",
    install_year: 2017,
    condition_rating: null,
    expected_lifespan_years: null,
    material_or_model: null,
    created_at: "2024-01-01",
  },
  {
    id: "sys-hvac",
    property_id: "prop-1",
    system_type: "hvac",
    install_year: 2012,
    condition_rating: null,
    expected_lifespan_years: null,
    material_or_model: null,
    created_at: "2024-01-02",
  },
  {
    id: "sys-fence",
    property_id: "prop-1",
    system_type: "fence",
    install_year: 2023,
    condition_rating: null,
    expected_lifespan_years: null,
    material_or_model: null,
    created_at: "2024-01-03",
  },
];

// Chainable Supabase stub. Thenable so `await` and Promise.all resolve it, and
// carrying maybeSingle for the page's own small repair_reserve_cents read.
function chain(data: unknown, single: unknown = null) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    limit: () => obj,
    maybeSingle: () => Promise.resolve({ data: single, error: null }),
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({ data, error: null }),
  };
  return obj;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) =>
      table === "home_systems"
        ? chain(systems)
        : table === "properties"
          ? chain(null, { repair_reserve_cents: fixtures.reserveCents })
          : chain([]),
    // The free branch reads the user id once for the paywall-experiment
    // variant on the unlock card's sub-line (src/lib/paywallExperiment.ts).
    // A fixed id keeps the rendered variant deterministic for these tests;
    // the sub-line's exact wording is asserted nowhere here, only that the
    // card renders, so either arm satisfies the suite.
    auth: {
      getUser: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-000000000001" } },
      }),
    },
  })),
}));

// Server actions cannot run in jsdom; the markup that references them is what
// this file is about.
vi.mock("./actions", () => ({
  addForecastStepAction: vi.fn(),
  saveRepairReserveAction: vi.fn(),
}));

import ForecastPage from "./page";
import { buildForecast } from "@/lib/forecast";

// Mirror of the page's own money() formatter, so the free-render assertions
// compare against exactly the strings the member view would print.
function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

async function renderForecast(over: Partial<typeof fixtures> = {}) {
  fixtures.plus = over.plus ?? true;
  fixtures.reserveCents = over.reserveCents ?? null;
  const element = await ForecastPage();
  return render(element as React.ReactElement);
}

describe("forecast page, Hearth Plus member", () => {
  it("shows the push-it-out step for a system, with a range and no fake precision", async () => {
    await renderForecast();
    expect(
      screen.getByText("Flush the tank and have the anode rod checked")
    ).toBeInTheDocument();
    // A range and the word "typically", never one confident number.
    const line = screen.getByText(/pushes a \$[\d,]+ water heater replacement/);
    expect(line.textContent).toMatch(/^Typically \$\d+ to \$\d+,/);
    expect(line.textContent).toMatch(/out 2-3 years\.$/);
  });

  it("offers to add the step to the maintenance plan and to find a pro", async () => {
    const { container } = await renderForecast();
    expect(
      screen.getAllByRole("button", { name: "Add to my plan" }).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Find a pro").length).toBeGreaterThan(0);
    // The trade link goes to the right category for the system.
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href")
    );
    expect(hrefs).toContain("/contractors?category=plumbing");
  });

  it("shows the reserve plan with a set-aside and an invitation, not a scolding", async () => {
    await renderForecast({ reserveCents: null });
    expect(screen.getByText("Your repair reserve")).toBeInTheDocument();
    expect(
      screen.getByLabelText("What you have saved so far")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tell us what you have set aside/)
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing entered yet.")).toBeInTheDocument();
  });

  it("prefills the saved figure in dollars once one exists", async () => {
    await renderForecast({ reserveCents: 450000 });
    expect(screen.getByLabelText("What you have saved so far")).toHaveValue(
      "4500"
    );
    expect(screen.getByText(/\$4,500 of \$[\d,]+ set aside\./)).toBeInTheDocument();
  });

  it("shows the rebate line next to the replacement it belongs to", async () => {
    await renderForecast();
    expect(
      screen.getByText(
        "Up to $8,000 back: Heat pump instead of a like-for-like furnace or AC"
      )
    ).toBeInTheDocument();
    // The caveat and the as-of date travel with the amounts.
    expect(screen.getAllByText(/Table last checked \d{4}-\d{2}\./).length)
      .toBeGreaterThan(0);
  });

  it("sees the full page with no blur and no unlock card", async () => {
    const { container } = await renderForecast();
    expect(
      container.querySelector('[data-testid="forecast-tease"]')
    ).toBeNull();
    expect(
      screen.queryByText(/Your full breakdown is ready/)
    ).not.toBeInTheDocument();
  });

  it("offers early quotes on the highest-risk systems, prefilled and dated", async () => {
    const { container } = await renderForecast();
    expect(screen.getByTestId("quote-early-card")).toBeInTheDocument();
    expect(
      screen.getByText(/Emergency replacements typically cost 20-40% more\./)
    ).toBeInTheDocument();
    const quoteLinks = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.textContent === "Line up quotes"
    );
    expect(quoteLinks.length).toBeGreaterThan(0);
    expect(quoteLinks.length).toBeLessThanOrEqual(2);
    const href = quoteLinks[0].getAttribute("href") ?? "";
    expect(href).toContain("/contractors?category=");
    expect(href).toContain("timing=flexible");
    expect(href).toContain("desc=");
    // The prefilled description has to clear the 20-character floor
    // postJobAction enforces, or the prefill lands on a form that will not post.
    const desc = decodeURIComponent(href.split("desc=")[1] ?? "");
    expect(desc.length).toBeGreaterThan(20);
  });
});

describe("forecast page, free reader", () => {
  it("keeps both real headline numbers visible above the paywall", async () => {
    const { container } = await renderForecast({ plus: false });
    const forecast = buildForecast(
      systems as unknown as Parameters<typeof buildForecast>[0],
      new Date().getFullYear(),
      property.state,
      10,
      []
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/plan for about\s*\$[\d,]+/);
    expect(text).toMatch(/Set aside about \$[\d,]+\/month/);
    // And they are the REAL figures, not banded ones.
    expect(text).toContain(money(forecast.totalMidCost));
    expect(text).toContain(money(forecast.monthlySetAside));
  });

  it("renders the breakdown blurred, unreadable to assistive tech, with nothing tabbable inside", async () => {
    const { container } = await renderForecast({ plus: false });
    const tease = container.querySelector('[data-testid="forecast-tease"]');
    expect(tease).not.toBeNull();
    expect(tease).toHaveAttribute("aria-hidden", "true");
    expect(tease!.className).toContain("blur-sm");
    expect(tease!.className).toContain("pointer-events-none");
    expect(tease!.className).toContain("select-none");
    // No link, form control or tabindex inside the tease: the blur must not
    // hide something a keyboard can still reach.
    expect(
      tease!.querySelectorAll("a, button, input, select, textarea, [tabindex]")
    ).toHaveLength(0);
  });

  it("shows the unlock card with the Plus CTA over the blur", async () => {
    await renderForecast({ plus: false });
    expect(
      screen.getByText(/Your full breakdown is ready/)
    ).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "Get Hearth Plus" });
    expect(cta).toHaveAttribute("href", "/plus?reason=forecast");
  });

  it("never puts the exact per-system figures in the free DOM, only banded ones", async () => {
    const { container } = await renderForecast({ plus: false });
    const forecast = buildForecast(
      systems as unknown as Parameters<typeof buildForecast>[0],
      new Date().getFullYear(),
      property.state,
      10,
      []
    );
    const text = container.textContent ?? "";
    // The member view prints each system's exact "low - high" range; the free
    // render must not contain a single one of those strings anywhere.
    expect(forecast.timeline.length).toBeGreaterThan(0);
    for (const item of forecast.timeline) {
      expect(text).not.toContain(
        `${money(item.costLow)} - ${money(item.costHigh)}`
      );
    }
  });

  it("still gets no working reserve form, plan buttons or rebate amounts", async () => {
    await renderForecast({ plus: false });
    expect(
      screen.queryByLabelText("What you have saved so far")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add to my plan" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Up to \$[\d,]+ back:/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("quote-early-card")).not.toBeInTheDocument();
  });
});
