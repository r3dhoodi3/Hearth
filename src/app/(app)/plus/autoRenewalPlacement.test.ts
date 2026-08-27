import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A source test, not a render test, because the thing being protected is a
// PLACEMENT: the auto-renewal disclosure has to sit inside the same form as
// the button that starts a Stripe checkout, on both pricing pages. ROSCA
// (15 U.S.C. 8403(1)) wants the material terms disclosed before billing
// information is obtained, and California's Automatic Renewal Law (Bus. &
// Prof. Code 17602(a)(1)) wants them in visual proximity to the request for
// consent. A refactor that moves the terms into a footer, a tooltip, or
// behind a link would still render fine and still pass a smoke test; it would
// fail here.
const FILES = {
  "homeowner PlanToggle": "src/app/(app)/plus/PlanToggle.tsx",
  "pro ProPlanToggle": "src/app/pro/plus/ProPlanToggle.tsx",
};

// Paths from the repo root: vitest runs there, and a path relative to this
// file would have to encode the "(app)" route group through a URL, which is
// noisier than it is worth.
function source(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// Everything the two files use to render a button that submits a checkout
// form. If a new one is introduced it belongs in this list, not outside it.
const CHECKOUT_BUTTONS = ["<SubmitButton", "<CheckoutButton"];

describe("auto-renewal disclosure placement", () => {
  for (const [name, rel] of Object.entries(FILES)) {
    describe(name, () => {
      const src = source(rel);

      it("renders AutoRenewalTerms", () => {
        expect(src).toContain("<AutoRenewalTerms");
      });

      it("puts every checkout form's terms in the same form as its button", () => {
        // Split on the form openings so each checkout form is checked on its
        // own: a page with two checkout buttons needs two disclosures.
        const forms = src
          .split("<form action={")
          .slice(1)
          .map((chunk) => chunk.split("</form>")[0]);
        expect(forms.length).toBeGreaterThan(0);

        for (const form of forms) {
          const hasButton = CHECKOUT_BUTTONS.some((b) => form.includes(b));
          if (!hasButton) continue;
          expect(form).toContain("<AutoRenewalTerms");
        }
      });

      it("keeps the terms within a screen's reach of the button", () => {
        // Nothing long may be wedged between the disclosure and the act of
        // consent. 1600 source characters is roughly a screenful of JSX, so a
        // whole extra section pushed in between fails.
        let at = src.indexOf("<AutoRenewalTerms");
        expect(at).toBeGreaterThan(-1);
        while (at !== -1) {
          const window = src.slice(
            Math.max(0, at - 1600),
            at + 1600
          );
          const near = CHECKOUT_BUTTONS.some((b) => window.includes(b));
          expect(near, `no checkout button near the disclosure at ${at}`).toBe(
            true
          );
          at = src.indexOf("<AutoRenewalTerms", at + 1);
        }
      });

      it("gives the terms the plan the checkout form posts", () => {
        // A hard-coded plan on the disclosure is only allowed when the hidden
        // field in the same form is hard-coded to the matching cadence (the
        // trial button at the top of each page). Anywhere else the disclosure
        // has to read the selected plan.
        const forms = src
          .split("<form action={")
          .slice(1)
          .map((chunk) => chunk.split("</form>")[0]);

        for (const form of forms) {
          if (!form.includes("<AutoRenewalTerms")) continue;
          const fixedField = /name="plan" value="(monthly|yearly)"/.exec(form);
          if (fixedField) {
            // Hard-coded field, so a hard-coded disclosure that names the same
            // cadence. Pro prefixes its plans with pro_.
            const cadence = fixedField[1];
            expect(form).toMatch(
              new RegExp(`<AutoRenewalTerms\\s+plan="(pro_)?${cadence}"`)
            );
          } else {
            // Reader-controlled field, so the disclosure must read the same
            // state the field does rather than a literal.
            expect(form).toMatch(/name="plan" value=\{/);
            expect(form).toMatch(/<AutoRenewalTerms\s+plan=\{/);
          }
        }
      });
    });
  }
});
