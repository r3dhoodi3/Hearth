import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test, same reason src/app/pro/page.test.tsx is one: DepositForm's
// sibling actions module pulls in the service-role Supabase client at
// import time and a full render would need to mock the whole chain for one
// className check.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const form = src("./DepositForm.tsx");

// CEO pass D1: the non-refundable deposit disclaimer was 12px (text-xs) with
// no phone bump, unlike the minimum-deposit line right below it which
// already had max-sm:text-sm. Now both match.
describe("pro billing: deposit disclaimer is readable on a phone", () => {
  it("carries max-sm:text-sm like the minimum-deposit line below it", () => {
    expect(form).toContain(
      'className="text-xs text-stone-500 max-sm:text-sm dark:text-stone-400"'
    );
    expect(form).toContain(
      "Deposits are non-refundable and can only be spent on leads."
    );
  });

  it("does not touch the minimum-deposit line's own max-sm:text-sm rule", () => {
    // Guards against undoing the same-night D10/D11 work on this file.
    expect(form).toContain(
      'className="mt-1 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400"'
    );
  });
});
