// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// "./project-actions" is a "use server" file; mocked out so the test stays in
// the UI layer regardless of what it imports underneath, the same way
// ReviewPrompt.test.tsx and the other profile-card tests mock their actions.
// Never resolves during the test, matching src/components/SubmitButton.test.tsx's
// own double-click test: a REAL server action is async and stays pending for
// at least one network round trip, so `pending` from useFormStatus does not
// flip back to false (and reset the latch) between the two synchronous
// clicks below. A plain vi.fn() returning undefined would settle instantly
// and defeat the very race this test exists to catch.
const saveProjectAction = vi.fn((..._args: unknown[]) => new Promise(() => {}));
const deleteProjectAction = vi.fn();
vi.mock("./project-actions", () => ({
  saveProjectAction: (...args: unknown[]) => saveProjectAction(...args),
  deleteProjectAction: (...args: unknown[]) => deleteProjectAction(...args),
}));

// ProjectPhotoManager (always present in the create/edit form) constructs
// the real browser Supabase client at render time, which throws without live
// project env vars. Only the constructor is ever reached in this test (no
// upload is triggered), so a bare stub is enough.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
}));

import ProjectsCard from "./ProjectsCard";

afterEach(() => {
  cleanup();
  saveProjectAction.mockClear();
});

describe("ProjectsCard's Save Project button: double-submit latch", () => {
  it("submits once when clicked twice in rapid succession", () => {
    render(
      <ProjectsCard
        contractorId="c1"
        member={false}
        trialEligible={false}
        projects={[]}
      />
    );
    // No projects yet: only "Add Project" shows, which opens the create form.
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));

    const title = screen.getByPlaceholderText(
      "e.g. Full kitchen remodel in Maple Grove"
    );
    fireEvent.change(title, { target: { value: "Kitchen remodel" } });

    const saveButton = screen.getByRole("button", { name: "Add Project" });
    // Two clicks back to back, before React gets a chance to re-render with
    // useFormStatus's pending flipped to true - the exact race this latch
    // exists to close.
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    expect(saveProjectAction).toHaveBeenCalledTimes(1);
  });
});
