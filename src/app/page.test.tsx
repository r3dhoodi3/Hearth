// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// Vitest globals are off in this repo (see vitest.config.ts), so
// testing-library's auto-cleanup never wires itself up on its own.
afterEach(() => cleanup());

// The landing page now serves two different visitors from one file:
//
//  - DESKTOP gets the marketing page it always had, unchanged.
//  - PHONE gets PhoneLanding and nothing else. Someone on a phone downloaded
//    the app already; the tour they used to scroll through here is now the
//    post-login guide (src/components/AppGuide.tsx).
//
// The split is pure CSS: `sm:hidden` on the phone block, `max-sm:hidden` on
// every marketing section. Nothing is deleted, so the copy still ships in the
// HTML for crawlers, and desktop cannot regress by accident. That makes the
// classes the thing worth testing - and the only thing a unit test CAN test,
// since jsdom does not evaluate media queries.
//
// Everything mocked below is a per-request dependency or a client widget that
// needs a browser (a lazy-loaded audio player, a photo cycler on a timer).
// The markup this covers is all page.tsx's own.

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/authCookie", () => ({
  hasAuthCookie: () => false,
}));

vi.mock("@/lib/auth", () => ({
  getVerifiedUser: vi.fn(async () => null),
}));

vi.mock("@/lib/contractor", () => ({
  getSides: vi.fn(async () => ({ homeowner: false, contractor: false })),
  landingFor: () => "/dashboard",
}));

// Stubbed, but with a marker so the section wrapper around the demo player is
// still findable below.
vi.mock("@/components/HeroDemoPlayerLazy", () => ({
  default: () => <div data-testid="hero-demo" />,
}));

vi.mock("@/components/HeroPhotoCycler", () => ({
  default: () => <div data-testid="hero-photos" />,
}));

import Home from "./page";

async function renderLanding() {
  const element = await Home({ searchParams: Promise.resolve({}) });
  return render(element as React.ReactElement);
}

describe("landing page, phone split", () => {
  it("puts the phone landing first, inside the warm band", async () => {
    const { container } = await renderLanding();
    const create = screen.getByRole("link", { name: "Create your account" });
    expect(create).toHaveAttribute("href", "/homeowner-signup");

    // The block itself is phone-only...
    const phoneBlock = create.closest("div.sm\\:hidden");
    expect(phoneBlock).not.toBeNull();

    // ...and the second door is inside it. Scoped, because the long desktop
    // footer has a "Sign in" link of its own.
    expect(within(phoneBlock as HTMLElement).getByRole("link", { name: "Sign in" }))
      .toHaveAttribute("href", "/signin");

    // ...and it is the first thing in the page, ahead of the desktop header.
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(
      phoneBlock!.compareDocumentPosition(header!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("hides every marketing section on phone without deleting it", async () => {
    const { container } = await renderLanding();

    // Header, hero (copy + photo carousel), and the demo player's section.
    expect(container.querySelector("header")).toHaveClass("max-sm:hidden");
    expect(
      screen
        .getByRole("heading", {
          name: /Know what your home needs before it costs you/i,
          level: 1,
        })
        .closest("div.grid")
    ).toHaveClass("max-sm:hidden");
    expect(screen.getByTestId("hero-photos")).toBeInTheDocument();
    expect(screen.getByTestId("hero-demo").closest("section")).toHaveClass(
      "max-sm:hidden"
    );

    // Everything below the fold, by the heading a reader would see.
    const sections = [
      "Find a pro for",
      "What we check",
      "How it works",
      "What Hearth watches for you",
      "Real people, real answers",
      "Quick questions",
      "For contractors",
    ];
    for (const heading of sections) {
      expect(screen.getByText(heading).closest("section")).toHaveClass(
        "max-sm:hidden"
      );
    }

    // The closing CTA repeats the h1's wording, so it is found by its button
    // instead; the hero uses the same label, and the closing one is second.
    const getStarted = screen.getAllByRole("link", {
      name: "Get started free",
    });
    expect(getStarted).toHaveLength(2);
    expect(getStarted[1].closest("section")).toHaveClass("max-sm:hidden");

    // The long four-column footer.
    expect(screen.getByText("All guides").closest("footer")).toHaveClass(
      "max-sm:hidden"
    );
  });

  it("leaves a minimal phone footer with Terms, which the block above has no door for", async () => {
    const { container } = await renderLanding();
    const phoneFooter = container.querySelector("footer.sm\\:hidden");
    expect(phoneFooter).not.toBeNull();
    // Privacy and Terms only: the other doors are in PhoneLanding already,
    // a few hundred pixels up the same short screen.
    const links = within(phoneFooter as HTMLElement).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/privacy",
      "/terms",
    ]);
  });

  it("keeps the invisible structured data on every width", async () => {
    const { container } = await renderLanding();
    expect(
      container.querySelectorAll('script[type="application/ld+json"]').length
    ).toBeGreaterThan(0);
  });
});
