// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same next/link stub every other component test in this repo uses (see
// BlockMenu.test.tsx), so this test does not need a Next.js router context.
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

import Breadcrumbs, { BreadcrumbJsonLd, breadcrumbListJsonLd } from "./Breadcrumbs";

afterEach(cleanup);

describe("Breadcrumbs", () => {
  it("renders every label in order", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Notifications" },
        ]}
      />
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("links every crumb except the current page", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Notifications" },
        ]}
      />
    );
    expect(screen.getByText("Home").closest("a")).toHaveAttribute("href", "/dashboard");
    expect(screen.getByText("Account").closest("a")).toHaveAttribute("href", "/account");
    // The current page is plain text, not a link.
    expect(screen.getByText("Notifications").closest("a")).toBeNull();
  });

  it("marks the current page with aria-current", () => {
    render(
      <Breadcrumbs
        items={[{ label: "Home", href: "/dashboard" }, { label: "Documents" }]}
      />
    );
    expect(screen.getByText("Documents")).toHaveAttribute("aria-current", "page");
  });

  it("does not treat a link as current even if it happens to be last minus collapse", () => {
    // Two-item trail: only the last item (no href) is "current". A middle
    // link should never carry aria-current.
    render(
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Household" },
        ]}
      />
    );
    expect(screen.getByText("Account")).not.toHaveAttribute("aria-current");
  });

  it("collapses middle crumbs to a single ellipsis past 3 levels", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Clients", href: "/pro/crm" },
          { label: "Some Company", href: "/pro/crm/some-company" },
          { label: "Jane Smith" },
        ]}
      />
    );
    // First and last survive, the two middle crumbs collapse into one "…".
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.queryByText("Clients")).not.toBeInTheDocument();
    expect(screen.queryByText("Some Company")).not.toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
    // The ellipsis crumb is not a link.
    expect(screen.getByText("…").closest("a")).toBeNull();
  });

  it("leaves a 3-level trail alone (no collapse)", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Notifications" },
        ]}
      />
    );
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });
});

describe("breadcrumbListJsonLd", () => {
  it("builds a schema.org BreadcrumbList with resolved URLs, positions from 1", () => {
    const json = breadcrumbListJsonLd(
      [
        { name: "Home", href: "/" },
        { name: "Guides", href: "/guides" },
        { name: "ADU cost in Orange County" },
      ],
      "https://example.com"
    );
    expect(json["@context"]).toBe("https://schema.org");
    expect(json["@type"]).toBe("BreadcrumbList");
    expect(json.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
      { "@type": "ListItem", position: 2, name: "Guides", item: "https://example.com/guides" },
      { "@type": "ListItem", position: 3, name: "ADU cost in Orange County" },
    ]);
  });

  it("passes an already-absolute href through unchanged", () => {
    const json = breadcrumbListJsonLd(
      [{ name: "Home", href: "https://other.example/" }],
      "https://example.com"
    );
    expect(json.itemListElement[0]).toMatchObject({ item: "https://other.example/" });
  });
});

describe("BreadcrumbJsonLd", () => {
  it("renders a script tag with the matching ld+json payload", () => {
    const { container } = render(
      <BreadcrumbJsonLd
        items={[{ name: "Home", href: "/" }, { name: "Guides" }]}
        siteUrl="https://example.com"
      />
    );
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeInTheDocument();
    const parsed = JSON.parse(script!.innerHTML);
    expect(parsed["@type"]).toBe("BreadcrumbList");
    expect(parsed.itemListElement).toHaveLength(2);
    expect(parsed.itemListElement[1]).toEqual({ "@type": "ListItem", position: 2, name: "Guides" });
  });
});
