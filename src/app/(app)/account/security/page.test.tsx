// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// CEO pass E (2026-08-30): a live check after a7c8c25 (which added the
// Breadcrumbs import to this page) reported no nav[aria-label="Breadcrumb"]
// in the served HTML for /account/security. Reading the source found no
// wrapping client tab component, no conditional return, and no redirect
// between the auth guard and the Breadcrumbs render - this page is a plain
// server component that renders Breadcrumbs directly, the same shape as
// /account/page.tsx (which the same check did not flag). This test renders
// the actual resolved element tree (the async component awaited, same as
// Next does before handing it to the renderer) so a future regression that
// DOES wrap or drop the crumb fails a test instead of only a live check.
//
// Same next/link stub every other component test in this repo uses.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/user", () => ({
  getUserProfile: vi.fn(async () => ({
    id: "u1",
    email: "homeowner@example.com",
    full_name: "Homeowner",
  })),
}));

vi.mock("@/lib/auth", () => ({
  getPasswordStatus: vi.fn(async () => ({
    hasPassword: true,
    provider: "email",
  })),
  getVerifiedUser: vi.fn(async () => ({
    id: "u1",
    email: "homeowner@example.com",
  })),
  providerLabel: vi.fn(() => "Email and password"),
}));

// The four "use server" actions pull in the service-role Supabase client
// transitively, which throws under jsdom - mocked out exactly like
// PublicProfileForm.test.tsx mocks its own action module.
vi.mock("../actions", () => ({
  updateEmailAction: vi.fn(),
  updatePasswordAction: vi.fn(),
  signOutOthersAction: vi.fn(),
  deleteAccountAction: vi.fn(),
}));

// AccountSecurityPanel imports this one directly (not as a prop), and it
// pulls in next/headers via @/lib/supabase/server - same throws-under-jsdom
// reason as the mock above.
vi.mock("@/lib/passwordSetup", () => ({
  sendSetPasswordLinkAction: vi.fn(),
}));

import AccountSecurityPage from "./page";

afterEach(cleanup);

describe("/account/security: breadcrumb is server-rendered, not dropped by a client wrapper", () => {
  it("renders the Home > Account > Account security trail", async () => {
    // AccountSecurityPage is an async server component: awaiting it directly
    // (rather than mounting it through Next's own renderer) resolves every
    // await inside the function body first, exactly as Next does, and hands
    // back the plain element tree that would have gone into the response.
    const element = await AccountSecurityPage();
    render(element);

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent("Home");
    expect(nav).toHaveTextContent("Account");
    expect(nav).toHaveTextContent("Account security");
  });

  it("is not wrapped in a client tab panel: the trail and the tab strip are siblings", async () => {
    const element = await AccountSecurityPage();
    const { container } = render(element);

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const tablist = screen.getByRole("tablist");
    // Both are direct children of the same wrapper div, not one nested
    // inside a conditionally-rendered panel around the other.
    expect(nav.parentElement).toBe(container.firstElementChild);
    expect(tablist.parentElement?.parentElement).toBe(container.firstElementChild);
  });
});
