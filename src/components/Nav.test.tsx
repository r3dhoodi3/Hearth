// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Nav pulls in a stack of client components that poll/fetch/subscribe
// (UnreadProvider, NotificationBell, GlobalSearch, ...). None of that is
// relevant to the "Home" side pill this test covers, so each is stubbed to a
// bare passthrough - the real behavior of those components is covered by
// their own tests.
vi.mock("@/components/HomeSwitcher", () => ({ default: () => <div /> }));
vi.mock("@/components/NavLinks", () => ({ default: () => <div /> }));
vi.mock("@/components/ProfileMenu", () => ({ default: () => <div /> }));
vi.mock("@/components/ToolsMenu", () => ({ default: () => <div /> }));
vi.mock("@/components/GlobalSearch", () => ({ default: () => <div /> }));
vi.mock("@/components/NotificationBell", () => ({ default: () => <div /> }));
vi.mock("@/components/UnreadProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Nav imports this for the profile menu's switch-side action, which chains
// into the service-role admin client (`import "server-only"`) - unresolvable
// in a jsdom test and irrelevant to the pill this test covers.
vi.mock("@/lib/sideActions", () => ({ setPreferredSideAction: vi.fn() }));

import Nav from "./Nav";

afterEach(() => {
  cleanup();
});

const baseProps = {
  homes: [],
  activeId: "home-1",
  name: "Jamie",
  hasPlus: false,
};

describe("Nav side pill", () => {
  it("shows a 'Home' pill when the account also has a business side", () => {
    render(<Nav {...baseProps} hasPro />);
    // Two copies render (desktop inline + phone twin); either counts.
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });

  it("renders no pill for a homeowner-only account", () => {
    render(<Nav {...baseProps} hasPro={false} />);
    expect(screen.queryByText("Home")).toBeNull();
  });
});
