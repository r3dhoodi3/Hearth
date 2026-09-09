// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same rationale as Nav.test.tsx: stub the client subsystems that aren't
// relevant to the "Business" side pill this test covers.
vi.mock("@/components/NavLinks", () => ({ default: () => <div /> }));
// ProfileMenu is stubbed, but it records the links it was handed so the
// back-office tests below can check the destination without rendering the
// real menu (a client component with its own portals and focus handling).
vi.mock("@/components/ProfileMenu", () => ({
  default: ({ links }: { links: { href: string; label: string }[] }) => (
    <div
      data-testid="profile-menu"
      data-links={JSON.stringify(links.map((l) => [l.href, l.label]))}
    />
  ),
}));
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

describe("ProNav back office entry", () => {
  // Back office is no longer a header button (it duplicated the profile-menu
  // entry); the menu entry is the one door, and its destination is whatever
  // pro/layout.tsx computed - ProNav itself never decides between /pro/tools
  // and the buy page.
  function menuLinks() {
    const el = screen.getAllByTestId("profile-menu")[0];
    return JSON.parse(el.getAttribute("data-links") ?? "[]") as [string, string][];
  }

  it("sends Back office to /pro/tools when the pro can use it", () => {
    render(<ProNav company="Jamie's Roofing" hasHome={false} backOfficeHref="/pro/tools" />);
    expect(menuLinks()).toContainEqual(["/pro/tools", "Back office"]);
    expect(screen.queryByRole("link", { name: "AI back office" })).toBeNull();
  });

  it("sends Back office to the buy page when the pro cannot use it yet", () => {
    render(
      <ProNav company="Jamie's Roofing" hasHome={false} backOfficeHref="/pro/plus?reason=tools" />
    );
    expect(menuLinks()).toContainEqual(["/pro/plus?reason=tools", "Back office"]);
  });
});
