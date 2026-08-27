// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";

import DescriptionField from "./DescriptionField";
import { DraftJobProvider, useDraftJob } from "./DraftJobContext";

afterEach(() => {
  cleanup();
});

// Attaches a fake photo through the shared draft-job context on mount, the
// same way DraftablePhotoUpload would once an upload finishes, so
// DescriptionField's offerDraft-driven helper (the header "Draft it for me"
// button and the trailing sentence) actually renders.
function AttachPhoto() {
  const ctx = useDraftJob();
  useEffect(() => {
    ctx?.setPhotoUrls(["https://example.com/photo.jpg"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderWithPhoto() {
  render(
    <DraftJobProvider initialCategory="">
      <AttachPhoto />
      <DescriptionField initialDescription="" />
    </DraftJobProvider>
  );
}

// Regression test for the silent Post-job failure: DescriptionField used to
// unmount its "Draft it for me from the photo" button and its trailing
// helper sentence the instant the owner typed a character by hand, which
// shifted everything below it (the strong-post meter, the Post button)
// mid-tap. The fix keeps both mounted for as long as a photo is attached and
// only toggles visibility, so they must stay in the DOM across focus/blur
// and typing.
describe("DescriptionField helper stability", () => {
  it("keeps the draft-from-photo button and helper sentence mounted across focus, typing, and blur", () => {
    renderWithPhoto();

    const textarea = screen.getByLabelText("Details about your project");
    const draftButton = screen.getByRole("button", {
      name: "Draft it for me from the photo",
    });
    const helperSentence = screen.getByText(
      "Or let Hearth draft it from your photo, then edit."
    );

    expect(draftButton).toBeInTheDocument();
    expect(helperSentence).toBeInTheDocument();

    fireEvent.focus(textarea);
    expect(draftButton).toBeInTheDocument();
    expect(helperSentence).toBeInTheDocument();

    // Typing by hand is what used to unmount both nodes.
    fireEvent.change(textarea, {
      target: { value: "Need someone to fix a leaky kitchen faucet" },
    });
    expect(draftButton).toBeInTheDocument();
    expect(helperSentence).toBeInTheDocument();
    // No longer offered once typed by hand, but hidden via visibility, not
    // removal, so layout above the Post button never reflows.
    expect(draftButton).toHaveClass("invisible");
    expect(helperSentence).toHaveClass("invisible");

    fireEvent.blur(textarea);
    expect(draftButton).toBeInTheDocument();
    expect(helperSentence).toBeInTheDocument();
  });
});
