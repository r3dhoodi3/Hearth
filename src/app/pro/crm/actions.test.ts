import { beforeEach, describe, expect, it, vi } from "vitest";

// Tester report: "Add a client" showed "Adding..." but the list and the
// "Your clients (0)" counter never updated until a manual reload. The cause
// was the same-path App Router footgun already fixed on /pro/profile's save
// (src/app/pro/actions.ts, saveCompanyAction): a redirect() back to the exact
// path a form is already on can leave the route stuck on its loading.tsx
// boundary instead of resolving back to the real page. addClientAction and
// trackLeadAction both called revalidatePath("/pro/crm") and THEN
// redirect("/pro/crm") - the same page the form was already sitting on - on
// every exit, success and failure alike.
//
// These tests pin the fix: every exit from both actions revalidates
// "/pro/crm" and never redirects to it. A call to next/navigation's redirect
// is itself a test failure below (see the mock).
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => supabaseStub()),
}));

vi.mock("@/lib/contractor", () => ({
  getCurrentContractor: vi.fn(async () => currentContractor),
}));

vi.mock("@/lib/flash", () => ({ setFlash: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  // Any real navigation is exactly the bug this file guards against: a form
  // submitted from /pro/crm must never redirect back to /pro/crm.
  redirect: vi.fn((path: string) => {
    throw new Error(`unexpected redirect("${path}")`);
  }),
}));

import {
  addClientAction,
  trackLeadAction,
  updateClientDetailsAction,
  deleteClientAction,
  addNoteAction,
  deleteNoteAction,
} from "./actions";
import { setFlash } from "@/lib/flash";
import { revalidatePath } from "next/cache";

const currentContractor: { id: string } = { id: "contractor-1" };

let insertedRows: Record<string, unknown>[] = [];
let insertError: { message: string } | null = null;
let ownLeadRow: { id: string } | null = { id: "lead-1" };
// Backs every `select("id").eq(...).eq(...).maybeSingle()` against
// pro_clients: "already tracked" for trackLeadAction, and "is this the pro's
// own client" for addNoteAction / deleteNoteAction. Non-null means a row was
// found; each describe block below sets it to whatever that means there.
let alreadyTrackedRow: { id: string } | null = null;
let updatedValues: Record<string, unknown> | null = null;
let updateError: { message: string } | null = null;
// What the `.select("id")` on the ownership-scoped update/delete returns. An
// empty array is the "no row matched contractor_id" case: a tampered client
// id, or someone else's client. Postgrest reports that with no error at all,
// which is exactly why these writes have to read back what they touched.
let updatedRows: { id: string }[] = [{ id: "client-1" }];
let deletedRows: { id: string }[] = [{ id: "client-1" }];
let deleteError: { message: string } | null = null;
let insertedNotes: Record<string, unknown>[] = [];
let noteInsertError: { message: string } | null = null;
let noteDeleteError: { message: string } | null = null;

function supabaseStub() {
  return {
    from: (table: string) => {
      if (table === "pro_clients") {
        return {
          insert: async (values: Record<string, unknown>) => {
            if (!insertError) insertedRows.push(values);
            return { error: insertError };
          },
          update: (values: Record<string, unknown>) => {
            if (!updateError) updatedValues = values;
            return {
              eq: () => ({
                eq: () => ({
                  select: async () => ({
                    data: updateError ? null : updatedRows,
                    error: updateError,
                  }),
                }),
              }),
            };
          },
          delete: () => ({
            eq: () => ({
              eq: () => ({
                select: async () => ({
                  data: deleteError ? null : deletedRows,
                  error: deleteError,
                }),
              }),
            }),
          }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: alreadyTrackedRow }),
              }),
            }),
          }),
        };
      }
      if (table === "contractor_leads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: ownLeadRow }),
              }),
            }),
          }),
        };
      }
      if (table === "pro_client_notes") {
        return {
          insert: async (values: Record<string, unknown>) => {
            if (!noteInsertError) insertedNotes.push(values);
            return { error: noteInsertError };
          },
          delete: () => ({
            eq: () => ({
              eq: async () => ({ error: noteDeleteError }),
            }),
          }),
        };
      }
      throw new Error(`test does not expect a read/write to "${table}"`);
    },
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows = [];
  insertError = null;
  ownLeadRow = { id: "lead-1" };
  alreadyTrackedRow = null;
  updatedValues = null;
  updateError = null;
  updatedRows = [{ id: "client-1" }];
  deletedRows = [{ id: "client-1" }];
  deleteError = null;
  insertedNotes = [];
  noteInsertError = null;
  noteDeleteError = null;
});

describe("addClientAction", () => {
  it("inserts the client and revalidates /pro/crm without redirecting", async () => {
    await addClientAction(
      formData({ client_name: "Acme Plumbing", stage: "lead" })
    );

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      contractor_id: "contractor-1",
      client_name: "Acme Plumbing",
      stage: "lead",
    });
    expect(setFlash).toHaveBeenCalledWith("Client added.");
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("revalidates instead of redirecting on a validation failure", async () => {
    await addClientAction(formData({ client_name: "" }));

    expect(insertedRows).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith(
      "A client name is required.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("revalidates instead of redirecting when the insert fails", async () => {
    insertError = { message: "constraint violation" };

    await addClientAction(formData({ client_name: "Acme Plumbing" }));

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't add that client. Please try again.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("stops at the first invalid field rather than falling through to the insert", async () => {
    // No redirect() to throw and unwind the function any more, so every
    // validation branch needs its own explicit return - this pins that a
    // rejected name never reaches the insert with a bad or partial row.
    await addClientAction(
      formData({ client_name: "x".repeat(81), note: "fine" })
    );
    expect(insertedRows).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith(
      "Client name must be 80 characters or fewer.",
      "error"
    );
  });
});

describe("trackLeadAction", () => {
  it("tracks the lead and revalidates /pro/crm without redirecting", async () => {
    await trackLeadAction(
      formData({ lead_id: "lead-1", client_name: "Jane Homeowner" })
    );

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      contractor_id: "contractor-1",
      lead_id: "lead-1",
      client_name: "Jane Homeowner",
    });
    expect(setFlash).toHaveBeenCalledWith("Client tracked.");
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("revalidates instead of redirecting when the lead isn't the pro's own", async () => {
    ownLeadRow = null;

    await trackLeadAction(
      formData({ lead_id: "lead-1", client_name: "Jane Homeowner" })
    );

    expect(insertedRows).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith(
      "That job isn't yours to track.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("revalidates instead of redirecting when the lead is already tracked", async () => {
    alreadyTrackedRow = { id: "client-1" };

    await trackLeadAction(
      formData({ lead_id: "lead-1", client_name: "Jane Homeowner" })
    );

    expect(insertedRows).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith("Already tracking that one.");
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("flashes rather than failing silently when no lead id arrives", async () => {
    await trackLeadAction(formData({ client_name: "Jane Homeowner" }));

    expect(insertedRows).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith("Couldn't track that one.", "error");
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });
});

// The client detail page (/pro/crm/[id]) has its own same-path footgun: its
// forms used to redirect() back to the exact detail page they were already
// on, which is the same App Router bug addClientAction and trackLeadAction
// were fixed for above (redirect() unwinds through loading.tsx instead of
// resolving back to the real page). These three actions - the details save,
// adding a note, and removing a note - now revalidate that page instead.
describe("updateClientDetailsAction", () => {
  const CLIENT_ID = "client-1";

  it("saves the changes and revalidates both pages without redirecting", async () => {
    await updateClientDetailsAction(
      formData({
        id: CLIENT_ID,
        client_name: "Acme Plumbing",
        phone: "555-1212",
        email: "pro@acme.example",
        address: "1 Main St",
        est_value: "500",
        stage: "quoted",
        follow_up_on: "",
      })
    );

    expect(updatedValues).toMatchObject({
      client_name: "Acme Plumbing",
      phone: "555-1212",
      email: "pro@acme.example",
      stage: "quoted",
      est_value_cents: 50000,
    });
    expect(setFlash).toHaveBeenCalledWith("Client updated.");
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });

  it("revalidates the detail page instead of redirecting on a validation failure", async () => {
    await updateClientDetailsAction(
      formData({ id: CLIENT_ID, client_name: "" })
    );

    expect(updatedValues).toBeNull();
    expect(setFlash).toHaveBeenCalledWith(
      "A client name is required.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });

  it("stops at the first invalid field rather than falling through to the update", async () => {
    // No redirect() to throw and unwind the function any more, so every
    // validation branch needs its own explicit return - this pins that an
    // over-long name never reaches the update with a bad email alongside it.
    await updateClientDetailsAction(
      formData({
        id: CLIENT_ID,
        client_name: "x".repeat(81),
        email: "not-an-email",
      })
    );

    expect(updatedValues).toBeNull();
    expect(setFlash).toHaveBeenCalledTimes(1);
    expect(setFlash).toHaveBeenCalledWith(
      "Client name must be 80 characters or fewer.",
      "error"
    );
  });

  it("revalidates instead of redirecting when the update fails", async () => {
    updateError = { message: "constraint violation" };

    await updateClientDetailsAction(
      formData({ id: CLIENT_ID, client_name: "Acme Plumbing" })
    );

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't save your changes. Please try again.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });

  it("refuses a client that isn't this pro's, even though the write reported no error", async () => {
    updatedRows = [];

    await updateClientDetailsAction(
      formData({ id: "someone-elses-client", client_name: "Acme Plumbing" })
    );

    expect(setFlash).toHaveBeenCalledWith("That client isn't yours.", "error");
    expect(setFlash).not.toHaveBeenCalledWith("Client updated.");
    expect(revalidatePath).not.toHaveBeenCalledWith("/pro/crm");
  });
});

describe("deleteClientAction", () => {
  const CLIENT_ID = "client-1";

  it("refuses a client that isn't this pro's instead of claiming it was removed", async () => {
    deletedRows = [];

    await deleteClientAction(formData({ id: "someone-elses-client" }));

    expect(setFlash).toHaveBeenCalledWith("That client isn't yours.", "error");
    expect(setFlash).not.toHaveBeenCalledWith("Client removed.");
  });

  it("revalidates the detail page instead of redirecting to it when the delete fails", async () => {
    deleteError = { message: "constraint violation" };

    await deleteClientAction(formData({ id: CLIENT_ID }));

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't remove that client. Please try again.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });
});

describe("addNoteAction", () => {
  const CLIENT_ID = "client-1";

  it("adds the note and revalidates without redirecting", async () => {
    alreadyTrackedRow = { id: CLIENT_ID };

    await addNoteAction(
      formData({ client_id: CLIENT_ID, body: "Called, left voicemail." })
    );

    expect(insertedNotes).toHaveLength(1);
    expect(setFlash).toHaveBeenCalledWith("Note added.");
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith("/pro/crm");
  });

  it("revalidates instead of redirecting when the note is empty", async () => {
    alreadyTrackedRow = { id: CLIENT_ID };

    await addNoteAction(formData({ client_id: CLIENT_ID, body: "" }));

    expect(insertedNotes).toHaveLength(0);
    expect(setFlash).toHaveBeenCalledWith("A note can't be empty.", "error");
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });

  it("revalidates instead of redirecting when the insert fails", async () => {
    alreadyTrackedRow = { id: CLIENT_ID };
    noteInsertError = { message: "db error" };

    await addNoteAction(
      formData({ client_id: CLIENT_ID, body: "Called, left voicemail." })
    );

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't add that note. Please try again.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });
});

describe("deleteNoteAction", () => {
  const CLIENT_ID = "client-1";

  it("removes the note and revalidates without redirecting", async () => {
    alreadyTrackedRow = { id: CLIENT_ID };

    await deleteNoteAction(
      formData({ client_id: CLIENT_ID, note_id: "note-1" })
    );

    expect(setFlash).toHaveBeenCalledWith("Note removed.");
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });

  it("revalidates instead of redirecting when the delete fails", async () => {
    alreadyTrackedRow = { id: CLIENT_ID };
    noteDeleteError = { message: "db error" };

    await deleteNoteAction(
      formData({ client_id: CLIENT_ID, note_id: "note-1" })
    );

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't remove that note. Please try again.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/pro/crm/${CLIENT_ID}`);
  });
});
