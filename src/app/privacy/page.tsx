import { LegalContact } from "@/components/LegalContact";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

// Public top-level page, same pattern as src/app/fountain-valley/page.tsx:
// see src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Content is derived from the
// actual code paths (Supabase, Anthropic, Stripe, CSLB, Checkr) rather than a
// generic template.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";


export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Privacy Policy",
  description:
    "What Hearth collects, how it is used, who it is shared with, and how to delete it.",
  alternates: {
    canonical: `${SITE_URL}/privacy`,
  },
};

// The "At a glance" rows, held as data so the same rows can render as a table
// on a wide screen and as stacked cards on a phone without the wording
// drifting between the two.
const GLANCE_COLUMNS = [
  "Data",
  "Why we have it",
  "Linked to you",
  "Leaves Hearth?",
] as const;

const GLANCE_LABEL =
  "text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400";
const GLANCE_VALUE = "mt-0.5 leading-relaxed";

const GLANCE_ROWS: {
  data: string;
  why: ReactNode;
  linked: string;
  leaves: ReactNode;
}[] = [
  {
    data: "Name, email, phone",
    why: "Your login, notifications, and introducing you to a pro you contact",
    linked: "Yes",
    leaves:
      "Your email goes to Stripe at checkout. Your name, email and phone go to the specific pro you send a request to. Email and SMS reminders are delivered by Resend and Twilio when those channels are turned on.",
  },
  {
    data: "Home address and location",
    why: "Pre-filling your home facts, local pricing, weather alerts, and getting a pro to the right house",
    linked: "Yes",
    leaves:
      "Street + ZIP go to RentCast to look up county records and, when RentCast has one, an automated home-value estimate. The partial address you type while adding a home goes to Photon, a free OpenStreetMap-based lookup, so it can suggest matches as you type. Your address is included in the context sent to Anthropic when you use Ask Hearth. City and state go to Open-Meteo for the forecast behind weather alerts. Your full address goes to the pro you choose.",
  },
  {
    data: "Home facts and systems",
    why: "Year built, size, systems, ages, condition, issues and reminders, so advice is about your house",
    linked: "Yes",
    leaves:
      "Sent to Anthropic as context when you ask a question. Appliance brand names are sent to the CPSC public recall service to check for recalls.",
  },
  {
    data: "Home value and money details",
    why: "Purchase price, mortgage balance, assessed and market value, property tax, insurance and HOA, for equity, tax-appeal and insurance tools",
    linked: "Yes",
    leaves: (
      <>
        Some of these numbers arrive from RentCast&apos;s records lookup.
        Purchase price, assessed value, and Hearth&apos;s home-value estimate
        are sent to Anthropic only when you generate a Property Tax Appeal
        Kit. Insurance premium and renewal date are sent to Anthropic only
        when you generate an Insurance Requote Packet. Nothing else in this row
        leaves Hearth.
      </>
    ),
  },
  {
    data: "Photos and documents",
    why: "System photos, warranties, inspection reports and quotes",
    linked: "Yes",
    leaves:
      "Stored privately. Sent to Anthropic only when you attach one to a question or ask us to read a document. Dictation happens on your own device, so no audio is uploaded at all.",
  },
  {
    data: "Messages and support requests",
    why: "Your conversation with a pro, reviews you write, and anything you send our support inbox",
    linked: "Yes",
    leaves:
      "Visible to the pro on the other side of that thread. Not sent to any AI provider or advertiser.",
  },
  {
    data: "Payments",
    why: "Hearth Plus, pro lead fees, deposits and invoices",
    linked: "Yes",
    leaves:
      "Handled by Stripe. We store the Stripe customer and subscription id and the invoice totals, never your card number.",
  },
  {
    data: "Pro license and background checks",
    why: "Verifying a contractor is who they say they are (pro accounts only)",
    linked: "Yes",
    leaves:
      "License number is checked against the CSLB public registry. Where background checks are enabled, name and email go to Checkr; we store only the result.",
  },
  {
    data: "Usage counts",
    why: "A daily count of AI questions, to enforce plan limits",
    linked: "Yes",
    leaves: "No.",
  },
];

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        <Link href="/" className="text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300">
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Privacy Policy
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Last updated August 26, 2026. Plain English, and honest about what
        actually happens in the app today.
      </p>

      <div className="mt-8 space-y-8 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            At a glance
          </h2>
          <p className="mt-2 leading-relaxed">
            Every row below is what the app actually does today, not a
            template. &ldquo;Linked to you&rdquo; means the record is stored
            against your account rather than anonymously.
          </p>

          {/* The same rows twice: a real table from sm up, and a stack of
              labelled cards below it. A 4-column table only fits in a
              horizontal scroller on a phone, and the scroller gave no hint
              it could be scrolled, so three of the four columns were simply
              invisible to a phone reader. */}
          <div className="mt-4 hidden overflow-x-auto rounded-lg border border-stone-200 sm:block dark:border-stone-700">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead className="bg-stone-50 text-stone-900 dark:bg-stone-800 dark:text-stone-100">
                <tr>
                  {GLANCE_COLUMNS.map((c) => (
                    <th key={c} scope="col" className="px-3 py-2 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                {GLANCE_ROWS.map((r) => (
                  <tr key={r.data}>
                    <th
                      scope="row"
                      className="px-3 py-3 text-left align-top font-medium text-stone-900 dark:text-stone-100"
                    >
                      {r.data}
                    </th>
                    <td className="px-3 py-3 align-top">{r.why}</td>
                    <td className="px-3 py-3 align-top">{r.linked}</td>
                    <td className="px-3 py-3 align-top">{r.leaves}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone rendering of the same data. */}
          <ul className="mt-4 space-y-3 sm:hidden">
            {GLANCE_ROWS.map((r) => (
              <li
                key={r.data}
                className="rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-700"
              >
                <p className="font-semibold text-stone-900 dark:text-stone-100">
                  {r.data}
                </p>
                <dl className="mt-2 space-y-2">
                  <div>
                    <dt className={GLANCE_LABEL}>{GLANCE_COLUMNS[1]}</dt>
                    <dd className={GLANCE_VALUE}>{r.why}</dd>
                  </div>
                  <div>
                    <dt className={GLANCE_LABEL}>{GLANCE_COLUMNS[2]}</dt>
                    <dd className={GLANCE_VALUE}>{r.linked}</dd>
                  </div>
                  <div>
                    <dt className={GLANCE_LABEL}>{GLANCE_COLUMNS[3]}</dt>
                    <dd className={GLANCE_VALUE}>{r.leaves}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          <p className="mt-4 leading-relaxed">
            <span className="font-medium text-stone-900 dark:text-stone-100">
              What is not here:
            </span>{" "}
            there is no advertising SDK, no third-party analytics or session
            recorder, and no ad pixel anywhere in Hearth. We do not build an
            advertising profile or sell your data to anyone. The one thing we do
            keep is a set of scrambled (hashed) identifiers for your device,
            network, and payment method, used only to stop the same person
            farming free trials with new accounts. See &ldquo;What we don&apos;t
            do&rdquo; below for exactly what that means.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The short version
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth stores your account and home information so it can track
            your systems, remind you about maintenance, and answer your
            questions. We do not sell your personal data, and we do not run
            third-party ad trackers on the app. Below is exactly what we
            collect, who it is shared with, and how to delete it.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What we collect and where it lives
          </h2>
          <p className="mt-2 leading-relaxed">
            Your account details (name, email, and phone number if you add
            one) and your home details (address,
            year built, systems, condition, issues you report, reminders) are
            stored in our database, hosted by Supabase. Access is restricted
            to your own account.
          </p>
          <p className="mt-2 leading-relaxed">
            When you add a property, we check public county assessor records
            (through our property data provider, RentCast) to see whether the
            name on your account matches the name the county has on file for
            that address. We store the result as a simple verified or
            unverified flag on your property. We do not show the county&apos;s
            owner names to other users, including pros you contact.
          </p>
          <p className="mt-2 leading-relaxed">
            Hearth currently serves all of Orange County, California, 36
            cities and unincorporated communities in all, from Aliso Viejo to
            Yorba Linda. If the address you enter is outside that area, we
            still take it so we can add you to a waitlist and email you when
            we expand there; the rest of the app stays gated until then.
          </p>
          <p className="mt-2 leading-relaxed">
            The headline number on your Home Value page comes from
            RentCast&apos;s automated valuation model when RentCast has one
            for your address. When it doesn&apos;t, we calculate an estimate
            ourselves from the purchase price you entered and typical
            year-over-year price trends for your state. Either way, it&apos;s
            a ballpark, not an appraisal.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Ask Hearth and Anthropic
          </h2>
          <p className="mt-2 leading-relaxed">
            When you ask Ask Hearth a question, we send your question and
            relevant details about your home to Anthropic&apos;s Claude API so
            it can generate a useful, specific answer. To be specific about what
            &ldquo;details about your home&rdquo; means, because it is more
            than people expect: it includes your systems and their ages, your
            open reminders, your recently logged issues, the year your home
            was built, your city and state, and{" "}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              your street address
            </span>
            . We also send{" "}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              your first name
            </span>
            , so the answer can greet you by name. That request is processed
            server-side on Anthropic&apos;s systems. If you attach a photo,
            the photo is sent the same way so the model can look at it.
            Anthropic is the only AI provider Hearth uses; your question
            history is not sent to any other one.
          </p>
          <p className="mt-3 leading-relaxed">
            We do not send your messages with pros to Anthropic. We also do
            not send your mortgage balance: it is used only in your own
            maintenance-history calculations. We DO send some of your money
            details to Anthropic when you use specific tools: your purchase
            price, assessed value, and Hearth&apos;s own estimate of your
            home&apos;s market value when you generate a Property Tax Appeal
            Kit, and your current insurance premium and renewal date when you
            generate an Insurance Requote Packet. If you upload a
            contractor&apos;s quote to the quote analyzer, its full line
            items and total are sent to Anthropic so it can be read and
            evaluated. None of this is sent unless you actively use that
            specific tool.
          </p>
          <p className="mt-3 leading-relaxed">
            The pro side sends Anthropic its own data too. When a contractor
            uses Ask Hearth for Pros, we send their wallet balance (cash and
            bonus, in dollars), their license number and verification
            status, and their background-check status as context, so the
            assistant can answer questions about their account accurately.
            When a contractor uses the estimate or invoice tools in the pro
            back office, their own past-job dollar totals (labor and
            materials) are sent to Anthropic as pricing reference. When a
            contractor uploads a past invoice, quote, or receipt to build
            that pricing history, the full image, including its dollar line
            items, is sent to Anthropic so it can be read. None of this is a
            homeowner&apos;s data: it is the contractor&apos;s own account
            information.
          </p>
          <p className="mt-3 leading-relaxed">
            The AI provider is Anthropic, PBC, and Hearth is on its paid API.
            Under Anthropic&apos;s{" "}
            <a
              href="https://www.anthropic.com/legal/commercial-terms"
              className="text-bark-700 hover:underline dark:text-stone-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              commercial terms
            </a>
            , what is sent to the API and what comes back are not used to
            train Anthropic&apos;s models by default. Anthropic keeps API data
            for up to 30 days for trust and safety purposes. Voice input never
            reaches Anthropic at all: dictation runs on your own device, and
            only the text it produces is sent anywhere. See{" "}
            <Link href="/ai-disclosure" className="text-bark-700 hover:underline dark:text-stone-300">
              How Hearth Uses AI
            </Link>{" "}
            for the fuller explanation.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Photos and documents
          </h2>
          <p className="mt-2 leading-relaxed">
            Photos and documents you upload (system photos, warranties,
            inspection reports) are stored in private cloud storage, not a
            public bucket. When you or the app needs to display one, it is
            served through a short-lived signed link that expires rather than
            a permanent public URL.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cookies
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth sets a short list of first-party cookies, all needed for
            the app to work. None of them are third-party ad or tracking
            cookies, and none of them follow you to another company&apos;s
            site.
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
            <li>Supabase&apos;s own cookies keep you signed in.</li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                hearth_did
              </span>
              , a random id planted the first time you visit, kept for 400
              days. Used only to notice when more than one account is being
              created or paid for from the same device; see &ldquo;What we
              don&apos;t do&rdquo; below.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                hearth_fp
              </span>
              , a hash of a few features of your browser, used the same way
              as hearth_did.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                hearth_pwrecovery
              </span>
              , set only after you click a password reset link, and gone in
              15 minutes. It is what lets the &ldquo;set a new password&rdquo;
              screen work at all, and it stops a stranger from reaching that
              screen just by typing its address in your browser.
            </li>
            <li>
              A cookie that remembers which home is active, for anyone
              managing more than one property.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Payments</h2>
          <p className="mt-2 leading-relaxed">
            Payments (Hearth Plus, contractor fees, deposits) are processed by
            Stripe. Hearth never sees or stores your full card number; Stripe
            handles that directly.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Contractor license and background checks
          </h2>
          <p className="mt-2 leading-relaxed">
            When a contractor lists a California license number, we check it
            against the CSLB (Contractors State License Board) public
            license-lookup registry, the same public page any homeowner could
            look up themselves. Where background checks are enabled for a
            pro, they are run by Checkr, a third-party background check
            provider; Hearth stores only the pass/no-pass result, not the
            underlying report.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Public pro profiles
          </h2>
          <p className="mt-2 leading-relaxed">
            A pro only gets a public profile page if they picked at least one
            Orange County service city when they signed up, so nobody outside
            the launch area is listed. The business name and the About text
            on that page are checked before they go live: a submission with a
            slur, profanity, or a phone number or email address in place of
            Hearth&apos;s own messaging is rejected and the pro is told why,
            rather than published and reviewed later.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Notifications
          </h2>
          <p className="mt-2 leading-relaxed">
            We send notifications you opt into (pro messages, maintenance
            reminders, weather and safety alerts, and occasional product
            updates), which you can turn on or off individually under Account
            &gt; Notifications.
          </p>
          <p className="mt-3 leading-relaxed">
            In-app notifications stay inside Hearth. Email and text messages
            are handed to delivery providers to actually send: emails go
            through Resend, and text messages go through Twilio. That means
            your email address goes to Resend, your phone number goes to
            Twilio, and the contents of the notification go with them. Those
            channels are off unless we have the provider set up and you have
            the channel turned on; if a channel is off, nothing is sent to
            that provider.
          </p>
          <p className="mt-3 leading-relaxed">
            Texting is opt-in, off by default: you turn it on with a checkbox
            in Account settings, and pros use the same checkbox to opt into
            texts about new job leads. Twilio only sends to 10-digit US
            phone numbers, and every text ends with &ldquo;Reply STOP to opt
            out,&rdquo; which unsubscribes that number right away.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Weather and safety alerts
          </h2>
          <p className="mt-2 leading-relaxed">
            The freeze and heat-wave warnings on your dashboard need a real
            forecast for where you live, so we send your city and state to
            Open-Meteo, a free public weather service, to look up your
            location and its forecast. We do not send your street address or
            your name.
          </p>
          <p className="mt-3 leading-relaxed">
            To check whether anything in your home has been recalled, we send
            the brand names you entered for your systems and appliances (for
            example &ldquo;Carrier&rdquo; or &ldquo;Rheem&rdquo;) to the
            CPSC&apos;s public SaferProducts recall search, run by the U.S.
            Consumer Product Safety Commission. Only the brand word is sent,
            not your address, name, or model and serial numbers.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What a contractor sees
          </h2>
          <p className="mt-2 leading-relaxed">
            When you post a job, we save a snapshot of that request so a pro
            can quote it. That snapshot includes your name, your email
            address, your phone number, your property address, the job
            category, your description of the problem, how severe it is, your
            timing, and your budget range if you gave one. Pros who take on
            your job see that snapshot. They do not see your broader home
            profile: your other systems, your money details, your documents,
            or your Ask Hearth history.
          </p>
          <p className="mt-3 leading-relaxed">
            Separately, open jobs appear as an anonymous teaser on our public
            page for contractors, which anyone can see without an account. The
            teaser shows only the job category, how severe it is, the lead fee
            for that job, and a coarse area (the city portion of the address).
            It never shows your name, email, phone, or street address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What we don&apos;t do
          </h2>
          <p className="mt-2 leading-relaxed">
            We do not sell your personal data, and we do not share it with
            anyone beyond the providers named on this page.
          </p>
          <p className="mt-3 leading-relaxed">
            Hearth runs no third-party tracking of any kind. There is no
            third-party analytics service, no advertising SDK, no ad pixel or
            retargeting tag, no session recorder or heatmap tool, and no data
            broker receiving anything about you. We do not build an
            advertising profile of you. This is unusual, so it
            is worth saying plainly: the companies listed on this page get
            your data because they perform a job you asked for, not because
            they are watching you use the app. That includes Anthropic, the
            one AI provider on this list: see the AI section above for what it
            receives, and note that under its paid API terms your data is not
            used to train its models.
          </p>
          <p className="mt-3 leading-relaxed">
            Because of that, a browser&apos;s Do Not Track signal doesn&apos;t
            change anything here: there is no cross-site tracking for it to
            turn off. We don&apos;t track your activity across other
            companies&apos; sites and services, whether or not that signal is
            on, so we don&apos;t respond to it differently either way.
          </p>
          <p className="mt-3 leading-relaxed">
            Honestly, one thing is not a third party: Hearth records a small
            amount of its own first-party product-usage events, like which
            feature you used (for example, that a job was posted, or that the
            demo video was played), so we can see what is and isn&apos;t
            working and improve the app. Those events are stored as rows in
            Hearth&apos;s own database, linked to your account when you&apos;re
            signed in, and are never sold or shared with any third-party ad or
            analytics company.
          </p>
          <p className="mt-3 leading-relaxed">
            The other honest exception is free-trial abuse. Hearth stores
            scrambled (hashed) identifiers for your IP address, your
            hearth_did device cookie, your hearth_fp browser fingerprint
            cookie, your payment method, and, when you provide them, your
            phone number, company name, and home parcel number, so the same
            person can&apos;t keep claiming a new free trial by making new
            accounts. The scrambling is one-way and uses a secret key, so the
            stored value can&apos;t be turned back into your IP address, your
            card, or anything else about you. It is only ever compared
            against other accounts&apos; scrambled values, to link accounts
            that look like the same person, it is never used for advertising
            or shared with anyone, and it never follows you to another
            company&apos;s website.
          </p>
          <p className="mt-3 leading-relaxed">
            These records are kept only as long as your account exists, and
            are deleted along with everything else when you delete your
            account. A chargeback flags the account. A manual review may flag
            an account and remove its free-trial eligibility. Both are
            logged. Automated risk scoring may also affect trial eligibility
            once we turn it on.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Security and breach notice
          </h2>
          <p className="mt-2 leading-relaxed">
            We take reasonable steps to protect your information: photos and
            documents live in private storage and are only ever served
            through a short-lived signed link (see above), the cookie that
            carries a password-reset link is marked secure and httpOnly, your
            sign-in session cookie is marked secure too, and
            we never handle or store your full card number ourselves; Stripe
            does, and Hearth keeps only a scrambled fingerprint of the payment
            method, never the number itself. Changing your password requires
            either a session you&apos;re still actively signed into or a
            fresh emailed recovery link, and that link only works once and
            only for 15 minutes. No system is perfectly secure, and we
            can&apos;t promise your data will never be exposed. If a breach
            happens that affects your personal information, we&apos;ll notify
            you as required by California law.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Your privacy rights
          </h2>
          <p className="mt-2 leading-relaxed">
            If you are a California resident, you have these rights over your
            personal information: to know what we&apos;ve collected about you
            and where it came from, to get a copy of it, to have us delete it,
            to correct anything that&apos;s wrong, to opt out of the sale or
            sharing of it, and to limit how we use sensitive information such
            as your home&apos;s precise location, financial details, and
            message contents. Hearth does not sell your data or share it for
            advertising, so there is nothing to opt out of on that point, and
            we use sensitive information only to run Hearth itself, never to
            profile you or advertise to you. We will never deny you service or
            treat you worse for exercising any of these rights.
          </p>
          <p className="mt-3 leading-relaxed">
            One clarification worth being explicit about: when you contact a
            pro and we hand that pro your name, phone, email, and address
            (see &ldquo;What a contractor sees&rdquo; above), that is not a
            &ldquo;sale&rdquo; or a &ldquo;share&rdquo; under California law.
            It happens because you chose that pro and asked to be connected,
            to get the job you posted done, not to advertise to you or build
            a profile of you. The sale/share opt-out above is about the
            advertising-driven data flow Hearth doesn&apos;t do; sending your
            contact details to a pro you picked, at your request, is a
            different thing.
          </p>
          <p className="mt-3 leading-relaxed">
            We keep each category of data for as long as your account is
            open, aside from a narrow set of records the law requires us to
            keep, such as invoices and payment records.
          </p>
          <p className="mt-3 leading-relaxed">
            The controls to act on these rights, downloading your data,
            deleting your account, and correcting your profile, live in your
            account settings once you&apos;re signed in, under Account &gt;
            Your privacy rights. See{" "}
            <Link href="/account/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Your privacy rights
            </Link>{" "}
            for those controls, or reach us through{" "}
            <LegalContact />
            {" "}for anything they don&apos;t cover.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Deleting your data
          </h2>
          <p className="mt-2 leading-relaxed">
            You can permanently delete your account, and the data tied to it,
            at any time under Account &gt; Account security &gt; Delete
            Account. This cannot be undone.
          </p>
          <p className="mt-3 leading-relaxed">
            One honest caveat: if you shared information with a pro through a
            job or a conversation, that pro is a separate business, and they
            may keep their own copy of it, such as your name, phone, email,
            or address, in their own business records. Deleting your Hearth
            account removes your data from Hearth&apos;s systems, but it
            doesn&apos;t reach a pro&apos;s independent copy of what you sent
            them.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Changes to this policy
          </h2>
          <p className="mt-2 leading-relaxed">
            We may update this policy as Hearth changes. We&apos;ll always
            update the &quot;Last updated&quot; date at the top of this page.
            For a change that meaningfully affects what we collect, why, or
            who we share it with, we&apos;ll also give you notice, such as an
            email to the address on your account or a notice inside the app,
            before it takes effect. Continuing to use Hearth after that means
            you accept the change.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Questions</h2>
          <p className="mt-2 leading-relaxed">
            Questions about this policy or your data can be sent through{" "}
            <LegalContact />
            . If you have an account, you can also reach us from the Help
            page.
          </p>
        </section>
      </div>
    </main>
  );
}
