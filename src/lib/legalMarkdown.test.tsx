// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fillLegalTokens } from "@/lib/legal";
import { parseLegalDocument, renderLegalMarkdown, slugify } from "@/lib/legalMarkdown";

afterEach(() => cleanup());

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Trust signals, explained exactly")).toBe("trust-signals-explained-exactly");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  What Hearth is  ")).toBe("what-hearth-is");
  });
});

describe("parseLegalDocument", () => {
  it("pulls the title, last-updated line, and body apart", () => {
    const doc = parseLegalDocument(
      "# Terms of Service\n\nLast updated: 2026-09-02\n\n## First section\n\nSome text.\n"
    );
    expect(doc.title).toBe("Terms of Service");
    expect(doc.lastUpdated).toBe("2026-09-02");
    expect(doc.body.startsWith("## First section")).toBe(true);
  });

  it("collects every ## heading with its anchor id", () => {
    const doc = parseLegalDocument(
      "# Title\n\nLast updated: 2026-09-02\n\n## One\n\ntext\n\n## Two Words\n\ntext\n"
    );
    expect(doc.headings).toEqual([
      { id: "one", text: "One" },
      { id: "two-words", text: "Two Words" },
    ]);
  });
});

describe("renderLegalMarkdown", () => {
  it("renders headings with anchor ids", () => {
    const { container } = render(<>{renderLegalMarkdown("## Trust signals")}</>);
    const heading = container.querySelector("h2");
    expect(heading).toHaveAttribute("id", "trust-signals");
    expect(heading).toHaveTextContent("Trust signals");
  });

  it("renders bold, italic, and inline code", () => {
    render(<>{renderLegalMarkdown("This is **bold**, *italic*, and `code`.")}</>);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("renders an internal link with next/link and an external one with rel=noopener", () => {
    const { container } = render(
      <>{renderLegalMarkdown("See [Privacy](/privacy) or [Stripe](https://stripe.com/privacy).")}</>
    );
    const internal = screen.getByText("Privacy");
    expect(internal).toHaveAttribute("href", "/privacy");
    expect(internal).not.toHaveAttribute("target");

    const external = screen.getByText("Stripe");
    expect(external).toHaveAttribute("href", "https://stripe.com/privacy");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external.getAttribute("rel")).toContain("noopener");
    void container;
  });

  it("renders an unordered list with a nested sub-list", () => {
    const { container } = render(
      <>{renderLegalMarkdown("- Top item\n  - Nested item\n- Second top item\n")}</>
    );
    const topList = container.querySelector("ul");
    expect(topList).not.toBeNull();
    expect(screen.getByText("Nested item").closest("ul")).not.toBe(topList);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders an ordered list", () => {
    const { container } = render(<>{renderLegalMarkdown("1. First\n2. Second\n")}</>);
    expect(container.querySelector("ol")).not.toBeNull();
  });

  it("renders a table with a header row inside a scroll container", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const { container } = render(<>{renderLegalMarkdown(md)}</>);
    const scroller = container.querySelector(".overflow-x-auto");
    expect(scroller?.querySelector("table")).not.toBeNull();
    expect(scroller?.querySelectorAll("th")).toHaveLength(2);
    expect(screen.getByText("1").tagName).toBe("TD");
  });

  it("wraps a plain-language summary line in a highlighted box", () => {
    const { container } = render(
      <>{renderLegalMarkdown("**Plain-language summary:** We don't sell your data.")}</>
    );
    const box = screen.getByText(/We don't sell your data/).closest("div");
    expect(box?.className).toContain("rounded-md");
  });

  it("wraps a ## Summary section up to the next heading", () => {
    const md = "## Summary\n\nShort version.\n\n## Next section\n\nMore text.\n";
    const { container } = render(<>{renderLegalMarkdown(md)}</>);
    const summaryBox = screen.getByText("Short version.").closest("div");
    expect(summaryBox?.className).toContain("rounded-md");
    // The next section's heading and text sit outside the box.
    expect(summaryBox?.querySelector("#next-section")).toBeNull();
    expect(container.querySelector("#next-section")).not.toBeNull();
  });

  it("renders a blockquote and a horizontal rule", () => {
    const { container } = render(<>{renderLegalMarkdown("> A quoted line\n\n---\n")}</>);
    expect(container.querySelector("blockquote")).toHaveTextContent("A quoted line");
    expect(container.querySelector("hr")).not.toBeNull();
  });
});

describe("token filling before render", () => {
  it("fills {{TOKENS}} so the rendered heading carries the live brand, not the placeholder", () => {
    const filled = fillLegalTokens("## Welcome to {{BRAND}}");
    expect(filled).not.toContain("{{BRAND}}");
    render(<>{renderLegalMarkdown(filled)}</>);
    expect(document.querySelector("h2")?.textContent).toBe(filled.replace("## ", ""));
  });
});
