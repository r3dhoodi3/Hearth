// Pure builder for the Won-stage "ask for a review" text (CR4#4). Kept in its
// own module, separate from CrmView.tsx, so it can be unit tested directly:
// CrmView.tsx imports "./actions" ("use server"), which pulls in
// next/navigation, next/cache and the server-only Supabase client, so
// importing CrmView.tsx itself outside a real server render throws - the
// same reason src/app/pro/crm/page.test.ts reads CrmView.tsx as source text
// rather than importing it as a module.
//
// origin is passed in rather than read from window here, so the same
// function runs identically in a Node test and in the browser - callers use
// `typeof window !== "undefined" ? window.location.origin : ""`, the same
// SSR guard ReviewButton.tsx's and InviteNeighbor.tsx's own inviteUrl()
// helpers use.
export function reviewAskMessage(
  clientName: string,
  leadId: string,
  origin: string
): string {
  const firstName = clientName.trim().split(/\s+/)[0] || clientName;
  const url = `${origin}/contractors?review=${leadId}`;
  return `Hi ${firstName}, thanks for choosing me for the job! If you have a minute, a quick review on Hearth would mean a lot: ${url}`;
}
