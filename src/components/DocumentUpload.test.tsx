// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The vault's upload card is the surface that has to state the free-read meter
// BEFORE the tap and swap itself for the Plus door once the reads are gone
// (paywall UX rule: meter, don't wall, and show the meter before the limit).
// Everything the card needs that isn't that decision is mocked out: the
// browser Supabase client, the server action, and the four presentational
// children, none of which take part in the meter.

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.test/x" } }),
      }),
    },
  }),
}));

vi.mock("@/lib/document-actions", () => ({
  saveDocumentAction: async () => ({ ok: true }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/TakePhotoButton", () => ({
  default: () => <button type="button">Take a photo</button>,
}));

vi.mock("@/components/FilePreview", () => ({
  FilePreviewThumb: () => null,
}));

vi.mock("@/components/Lightbox", () => ({ default: () => null }));

vi.mock("@/components/AiNotice", () => ({ default: () => null }));

const { default: DocumentUpload } = await import("./DocumentUpload");

afterEach(() => {
  cleanup();
});

const PAYWALL_START = "You've used your 2 free document reads.";

describe("DocumentUpload free-read meter", () => {
  it("names the exact number left, in front of the picker", () => {
    render(<DocumentUpload propertyId="p1" freeReadsLeft={2} />);
    expect(screen.getByText(/2 of 2 free reads left/)).toBeInTheDocument();
    // The picker is still there: the meter is a note, not a wall.
    expect(
      screen.getByText(
        /Add a warranty, manual, receipt, or a photo of a model label/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PAYWALL_START))).toBeNull();
  });

  it("counts down as reads are spent", () => {
    render(<DocumentUpload propertyId="p1" freeReadsLeft={1} />);
    expect(screen.getByText(/1 of 2 free reads left/)).toBeInTheDocument();
  });

  it("turns the picker into the Plus door at zero", () => {
    render(<DocumentUpload propertyId="p1" freeReadsLeft={0} />);
    expect(screen.getByText(new RegExp(PAYWALL_START))).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Get Hearth Plus" });
    expect(link).toHaveAttribute("href", "/plus?reason=documents");
    // No picker to tap into a refusal.
    expect(
      screen.queryByText(
        /Add a warranty, manual, receipt, or a photo of a model label/
      )
    ).toBeNull();
  });

  it("shows a Plus member no meter and no door", () => {
    render(<DocumentUpload propertyId="p1" freeReadsLeft={null} />);
    expect(screen.queryByText(/free reads left/)).toBeNull();
    expect(screen.queryByText(new RegExp(PAYWALL_START))).toBeNull();
    expect(
      screen.getByText(
        /Add a warranty, manual, receipt, or a photo of a model label/
      )
    ).toBeInTheDocument();
  });

  it("defaults to no meter when the page passes nothing", () => {
    render(<DocumentUpload propertyId="p1" />);
    expect(screen.queryByText(/free reads left/)).toBeNull();
  });
});
