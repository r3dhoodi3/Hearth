// Playbook content: short, honest guides on how to win work on Hearth.
// Plain data (no JSX, no component references) so the server page can pass it
// straight through as a prop to the client accordion. Icons are stored as
// names, not lucide-react components: a live component reference is a
// function, and functions can't cross the server -> client boundary as a
// prop (see PlaybookGuide.tsx, which maps these names back to components on
// the client side).
export type PlaybookIconName =
  | "Flag"
  | "PenLine"
  | "Timer"
  | "Shield"
  | "Hourglass"
  | "Target"
  | "DollarSign"
  | "Repeat"
  | "Users";

export type PlaybookSection = {
  title: string;
  body: string[];
  // Index of a paragraph to render as a quoted example block (the good/bad
  // apply messages), if any.
  quote?: number;
};

export type PlaybookGuideData = {
  id: string;
  icon: PlaybookIconName;
  title: string;
  summary: string;
  sections: PlaybookSection[];
};

export const PLAYBOOK_GUIDES: PlaybookGuideData[] = [
  {
    id: "first-win",
    icon: "Flag",
    title: "Win your first job on Hearth",
    summary: "The shortest path from a fresh wallet to a first win.",
    sections: [
      {
        title: "Pick leads you can answer specifically",
        body: [
          "Start with jobs squarely in your trade that have a real description. A posting that says exactly what's wrong is one you can answer in detail, and detailed answers win. Save the vague one-liners for later.",
        ],
      },
      {
        title: "Apply when you can actually talk",
        body: [
          "Homeowners overwhelmingly go with the first pro who responds. Apply when you're free to answer a reply within the hour, not right before you go dark for a day. Being second with a better message still usually loses to being first.",
        ],
      },
      {
        title: "Make the message about their job",
        body: [
          "Mention their actual problem in your first line. Add one sentence on why you're the right fit, then offer a concrete time to talk or come look. That's the whole formula.",
        ],
      },
      {
        title: "Follow up once, not three times",
        body: [
          "If the homeowner hasn't replied after a day or two, send one short, friendly nudge in chat. One follow-up reads as helpful. Three reads as pressure.",
        ],
      },
      {
        title: "A quiet homeowner costs you nothing",
        body: [
          "If they never respond at all, ghost protection puts your fee back in your wallet as credit automatically after 7 days. The only thing a dead lead costs you is the wait, so don't let one silence sour you on the next application.",
        ],
      },
    ],
  },
  {
    id: "apply-message",
    icon: "PenLine",
    title: "Write an apply message homeowners answer",
    summary: "Their problem first, one line of proof, one concrete next step.",
    sections: [
      {
        title: "Lead with their problem, not your company",
        body: [
          "The homeowner is deciding between three messages. The one that opens with their leak gets read; the one that opens with 'we are a licensed and insured company' gets skimmed. Prove you read the posting in your first sentence.",
        ],
      },
      {
        title: "A message that works",
        body: [
          "Notice it names the problem, gives a reason to act, and ends with a time:",
          "Hi, I saw your water heater is leaking from the base. That usually means the tank itself, and it's worth a look soon before the floor takes damage. We handle these all the time in your area. I could stop by tomorrow between 2 and 4 for a free look if that works for you.",
        ],
        quote: 1,
      },
      {
        title: "A message that doesn't",
        body: [
          "This one never mentions their job once, so it reads like a flyer:",
          "Hello, we are a licensed and insured full-service company with 20 years of experience. We pride ourselves on quality workmanship and customer satisfaction. Call us anytime for all your service needs.",
          "Credentials matter, but they belong in one supporting line, not the opener.",
        ],
        quote: 1,
      },
      {
        title: "End with one concrete next step",
        body: [
          "Don't close with 'let me know if you're interested'. Offer a specific time to call or visit, so replying is as easy as typing 'yes'. The easier the yes, the faster it comes.",
        ],
      },
      {
        title: "Let the drafter start, then make it yours",
        body: [
          // Label kept in sync with ApplyJobButton.tsx's "Draft a message for
          // me" button (renamed 2026-08-30 for clarity on a phone).
          "The Draft a message for me button on any job writes a first pass from the posting and your company profile. Edit it before sending: one detail only you would know beats anything generated.",
        ],
      },
    ],
  },
  {
    id: "first-hour",
    icon: "Timer",
    title: "Why the first hour matters",
    summary: "Most jobs are decided before the second pro even replies.",
    sections: [
      {
        title: "The pattern worth remembering",
        body: [
          "Homeowners overwhelmingly go with the first pro who responds. Not the cheapest, not the most decorated: the first. Speed is the one advantage every pro can afford.",
        ],
      },
      {
        title: "Applying is only half of it",
        body: [
          "Your application starts the clock, it doesn't finish the race. When the homeowner replies in chat, the pro who answers in minutes feels reliable before any work has happened. Stay reachable for the hour after you apply.",
        ],
      },
      {
        title: "Set yourself up to be first",
        body: [
          "Two habits put you first in line:",
          "- Turn on notifications so you see new postings the moment they go up",
          "- Check the board during real gaps in your day, not just at night when everyone else does",
          "A fresh posting with zero spots taken is the best moment on Hearth to spend a fee.",
        ],
      },
      {
        title: "Fast beats polished",
        body: [
          "A good-enough message now wins against a perfect message tomorrow. Send the three solid sentences you have, and save the polish for the quote.",
        ],
      },
    ],
  },
  {
    id: "ghost-protection",
    icon: "Shield",
    title: "How ghost protection works",
    summary:
      "If the homeowner never responds, your fee comes back as wallet credit on its own.",
    sections: [
      {
        title: "The 7-day promise",
        body: [
          "Apply to a job and the homeowner has 7 days to respond. If they never do, your fee goes back into your wallet as credit automatically. No form, no support ticket, no asking.",
        ],
      },
      {
        title: "Not chosen? That fee comes back too",
        body: [
          "If the homeowner picks another pro, your apply fee comes back as wallet credit automatically the moment they pick, good for 60 days. You never lose money on a job you didn't get.",
        ],
      },
      {
        title: "Credit, not cash",
        body: [
          "The fee comes back as wallet credit you spend on your next application. It is never cash back to your card or your bank, on this or any of the other fee-back rules.",
        ],
      },
      {
        title: "You get back exactly what you paid",
        body: [
          "The credit is the exact amount you were charged. If you applied on an aging deal at 30% off, the discounted fee is what comes back.",
        ],
      },
      {
        title: "If they pick you later anyway",
        body: [
          "Sometimes a homeowner goes quiet, your fee comes back, then they return and choose you. When that happens the same fee is charged again, since the lead turned real after all. You only ever pay for a shot that actually existed.",
        ],
      },
      {
        title: "What it changes for you",
        body: [
          "The worst case on any application is a week of waiting, not lost money. That means the honest play is also the profitable one: apply to the jobs that fit, and let the quiet ones pay themselves back in credit.",
        ],
      },
    ],
  },
  {
    id: "aging-deals",
    icon: "Hourglass",
    title: "How aging deals work",
    summary: "Older leads get cheaper automatically, but fresh ones close best.",
    sections: [
      {
        title: "The discounts",
        body: [
          "A job that sits open 3 days gets 15% off the apply fee. At 7 days it becomes 30% off. The markdown happens automatically and shows right on the card.",
        ],
      },
      {
        title: "Why fresh still wins",
        body: [
          "A lead ages because pros passed on it or the homeowner is slow, and both lower your odds. The discount compensates you for that risk; it doesn't remove it. A fresh lead at full price is usually the better buy.",
        ],
      },
      {
        title: "When an aging deal is smart",
        body: [
          "Slow week, a job that fits your niche exactly, or a homeowner whose timing is flexible anyway: that's where a 30% off fee shines. Treat aging deals as filler for your pipeline, not the foundation of it.",
        ],
      },
    ],
  },
  {
    id: "spot-cap",
    icon: "Target",
    title: "How the 3-spot cap protects you",
    summary: "You're never one of thirty bids, at most one of three.",
    sections: [
      {
        title: "Three pros, not a pile-on",
        body: [
          "Every job takes at most 3 live applications, then it's closed to more. On the big lead sites your fee buys a spot in a crowd; here it buys one of three seats at the table.",
        ],
      },
      {
        title: "Apply early when you can",
        body: [
          "A card marks itself 'Job full' the moment all 3 seats are taken, so if you can still apply, a seat is open. Being first is the strongest position there is; the longer a job sits open, the faster you should decide whether you're clearly the right fit for what's written.",
        ],
      },
      {
        title: "Credited applications reopen spots",
        body: [
          "When ghost protection credits an application back, that spot opens back up. A job showing as full today can have room next week, so a full card isn't always gone for good.",
        ],
      },
    ],
  },
  {
    id: "pricing",
    icon: "DollarSign",
    title: "Price jobs so you win",
    summary: "Quote the work honestly and explain it; padding loses twice.",
    sections: [
      {
        title: "Quote the job, not the lead fee",
        body: [
          "Folding your apply fees into every quote makes you the expensive bid and lowers your win rate, which raises your real cost per job. Price the work on its own. The fees are a marketing cost that a healthy win rate pays for.",
        ],
      },
      {
        title: "Give a range early",
        body: [
          "Homeowners freeze when they have no idea of the number. A rough range in chat, with a clear note that the firm price comes after you see it, keeps things moving and filters out mismatches before you drive anywhere.",
        ],
      },
      {
        title: "Say what's included",
        body: [
          "Homeowners on Hearth get help reading quotes, so vague line items like 'materials' get questioned. Spell out the specifics and you win trust even when you aren't the lowest number:",
          "- Labor: hours or a flat rate",
          "- Materials: what's actually being installed, not just \"materials\"",
          "- Cleanup: haul-away and site cleanup included",
        ],
      },
      {
        title: "Know your floor",
        body: [
          "Decide the number below which a job isn't worth your crew's day, and hold it. Losing a bid costs you a fee. Winning a bad one costs you the week.",
        ],
      },
    ],
  },
  {
    id: "one-into-five",
    icon: "Repeat",
    title: "Turn one job into five",
    summary: "The cheapest lead you'll ever get is a customer you already have.",
    sections: [
      {
        title: "Communicate like it's the sales pitch",
        body: [
          "It is. Confirm when you'll arrive, message if you're running late, and explain what you found in plain words. Homeowners forgive a delayed job; they don't forgive a silent one.",
        ],
      },
      {
        title: "Finish clean and close the loop",
        body: [
          "Do the small things that get remembered: leave the site tidy, walk them through what you did, and tell them what to watch for. The last ten minutes of a job decide how it gets retold.",
        ],
      },
      {
        title: "Follow up a week later",
        body: [
          "One short message: is everything holding up, any questions? It takes a minute, almost nobody does it, and it's the moment homeowners mention you to a neighbor.",
        ],
      },
      {
        title: "Own their next problem",
        body: [
          "Every house has a next problem, and the pro who did the last job right is the first call. Mention what else you handle before you leave, and that homeowner may never post the next job at all: they'll just message you.",
        ],
      },
    ],
  },
  {
    id: "recommendation-threads",
    icon: "Users",
    title: "Win the \"anyone know a good plumber?\" thread",
    summary:
      "Where a neighbor's recommendation turns into your next job, done the honest way.",
    sections: [
      {
        title: "Join the groups where these threads happen",
        body: [
          "Join 3 to 5 local Facebook groups that cover your service area, plus Nextdoor. Homeowners ask \"anyone know a good plumber\" (or electrician, or roofer) in these groups constantly, often before they ever search online.",
        ],
      },
      {
        title: "Show up helpful before you need anything",
        body: [
          "Answer general questions in the group for a while without mentioning your business. Someone who's already seen you give a straight, useful answer trusts your reply a lot more once a recommendation thread actually shows up.",
        ],
      },
      {
        title: "When a thread matches your trade, help first",
        body: [
          "Reply with one sentence of real, specific help for their actual problem, then add your Hearth profile link so they can see your reviews and reach you. A reply that's all pitch and no help gets scrolled past.",
        ],
      },
      {
        title: "Ask happy customers to mention you on Nextdoor",
        body: [
          "After a job goes well, ask if they'd be willing to mention you the next time a neighbor asks. Most Nextdoor users say they value recommendations from their neighbors, so one genuine mention from a real customer carries real weight.",
        ],
      },
      {
        title: "Never recommend yourself",
        body: [
          "Posting a fake recommendation of your own business, or asking a friend to do it, is banned on every one of these platforms, and it's illegal under FTC rules against deceptive endorsements. Every mention has to come from an actual customer, or it isn't worth having.",
        ],
      },
      {
        title: "A blurb you can paste into a thread",
        body: [
          "Keep it short and about their problem first, your link second:",
          "This sounds like something in my line of work. Happy to take a look, here are my reviews and how to reach me: [your Hearth profile link]",
        ],
        quote: 1,
      },
    ],
  },
];
