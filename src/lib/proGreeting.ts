import { getOpenJobsForMe } from "@/lib/greeting";

// The pro copilot's opening line. Two surfaces show it - the floating dock in
// src/app/pro/layout.tsx and the full-screen /pro/ask page - and they must say
// the same thing, so the wording lives here rather than being written twice.
//
// If we can cheaply see how many open leads match their trades, reference it;
// otherwise fall back to the friendly generic. Wrapped so the RPC can never
// throw and take the shell or the page down with it.
export async function proGreeting(contractorName: string): Promise<string> {
  const generic = `Hi ${contractorName}. Ask me about winning leads, pricing a bid, your license badge, or growing your business.`;
  try {
    const openCount = (await getOpenJobsForMe()).length;
    if (openCount === 0) return generic;
    return `Hi ${contractorName}. There ${
      openCount === 1 ? "is" : "are"
    } ${openCount} open ${
      openCount === 1 ? "lead" : "leads"
    } matching your trades right now. Ask me how to win them, price a bid, or grow your business.`;
  } catch {
    return generic;
  }
}
