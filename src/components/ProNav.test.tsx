// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same rationale as Nav.test.tsx: stub the client subsystems that aren't
// relevant to the "Business" side pill this test covers.
vi.mock("@/components/NavLinks", () => ({ default: () => <div /> }));
vi.mock("@/components/ProfileMenu", () => ({ default: () => <div /> }));
vi.mock("@/components/NotificationBell", () => ({ default: () => <div /> }));
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
    render(<ProNav company="Jamie's Roofing" hasHome />);
    // Two copies render (desktop inline + phone twin); either counts.
    expect(screen.getAllByText("Business").length).toBeGreaterThan(0);
  });

  it("renders no pill for a pro-only account", () => {
    render(<ProNav company="Jamie's Roofing" hasHome={false} />);
    expect(screen.queryByText("Business")).toBeNull();
  });
});
