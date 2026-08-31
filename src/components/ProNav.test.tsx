// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same rationale as Nav.test.tsx: stub the client subsystems that aren't
// relevant to the "Business" side pill this test covers.
vi.mock("@/components/NavLinks", () => ({ default: () => <div /> }));
vi.mock("@/components/ProfileMenu", () => ({ default: () => <div /> }));
vi.mock("@/components/GlobalSearch", () => ({ default: () => <div /> }));
vi.mock("@/components/NotificationBell", () => ({ default: () => <div /> }));
vi.mock("@/components/UnreadProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// ProNav imports this for the profile menu's switch-side action, which
// chains into the service-role admin client (`import "server-only"`) -
// unresolvable in a jsdom test and irrelevant to the pill this test covers.
vi.mock("@/lib/sideActions", () => ({ setPreferredSideAction: vi.fn() }));

import ProNav from "./ProNav";

afterEach(() => {
  cleanup();
});

describe("ProNav side pill", () => {
  it("shows a 'Business' pill when the account also has a homeowner side", () => {
    render(<ProNav company="Jamie's Roofing" hasHome backOfficeHref="/pro/tools" />);
    // Two copies render (desktop inline + phone twin); either counts.
    expect(screen.getAllByText("Business").length).toBeGreaterThan(0);
  });

  it("renders no pill for a pro-only account", () => {
    render(<ProNav company="Jamie's Roofing" hasHome={false} backOfficeHref="/pro/tools" />);
    expect(screen.queryByText("Business")).toBeNull();
  });
});

describe("ProNav back office button", () => {
  // The button sits on the same header row as the bell, left of it, and its
  // destination is whatever pro/layout.tsx computed - ProNav itself never
  // decides between /pro/tools and the buy page.
  it("links to /pro/tools when the pro can use the back office", () => {
    render(<ProNav company="Jamie's Roofing" hasHome={false} backOfficeHref="/pro/tools" />);
    const link = screen.getByRole("link", { name: "AI back office" });
    expect(link).toHaveAttribute("href", "/pro/tools");
    // Always-on aria-label plus a text label that only shows from sm up
    // (max-sm:justify-center px-0 hides it visually on the phone, but jsdom
    // renders it regardless of viewport, so this checks it exists in markup).
    expect(link).toHaveTextContent("Back office");
  });

  it("links to the buy page when the pro cannot use it yet", () => {
    render(
      <ProNav company="Jamie's Roofing" hasHome={false} backOfficeHref="/pro/plus?reason=tools" />
    );
    const link = screen.getByRole("link", { name: "AI back office" });
    expect(link).toHaveAttribute("href", "/pro/plus?reason=tools");
  });
});
