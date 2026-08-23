import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  mapPhotonResults,
  normalizeSuggestQuery,
  photonSuggestUrl,
  type AddressSuggestion,
} from "@/lib/addressSuggest";

export const runtime = "nodejs";

// Address autocomplete for the onboarding street box.
//
// Input:  GET ?q=<partly typed street>&zip=<the ZIP box, optional>
// Output: { suggestions: AddressSuggestion[] }
//
// It goes through a server route rather than being fetched from the browser
// for two reasons: the page's CSP has no connect-src for photon.komoot.io and
// is not getting one, and a per-user rate limit is only enforceable somewhere
// the user cannot edit.
//
// THE INPUT MUST KEEP WORKING WITHOUT THIS. Photon is a free community service
// with no uptime promise, so every failure below - timeout, 500, garbage body,
// rate limit - answers 200 with an empty list. The suggestion list simply does
// not appear and the homeowner types the address the way they always could.
// The only non-200 is the signed-out case, which the middleware already
// handles before this file runs (/api is a guarded segment) and which is
// re-checked here anyway.

// Photon is a courtesy service. Three seconds is already longer than any
// useful autocomplete: past that the homeowner has typed another word and the
// answer is stale, so an empty list is the honest result.
const PHOTON_TIMEOUT_MS = 3000;

// Cached per exact query string. Address prefixes repeat constantly - every
// keystroke after a pause re-sends the same string, an Edit re-opens the same
// list, and two people in the same neighborhood type the same street - so a
// short memory keeps most keystrokes off Photon entirely. Ten minutes because
// OSM data does not move on a shorter horizon than that.
const CACHE_TTL_MS = 10 * 60 * 1000;
// A ceiling on the cache, because it is a module-level Map in a long-lived
// server process and an unbounded one is a slow memory leak dressed up as an
// optimization. Oldest-inserted entries are evicted first (Map preserves
// insertion order), which is a good enough approximation of LRU for a cache
// this size.
const CACHE_MAX_ENTRIES = 500;

type CacheEntry = { at: number; suggestions: AddressSuggestion[] };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): AddressSuggestion[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.suggestions;
}

function cacheSet(key: string, suggestions: AddressSuggestion[]): void {
  cache.set(key, { at: Date.now(), suggestions });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const EMPTY = { suggestions: [] as AddressSuggestion[] };

export async function GET(req: NextRequest) {
  // Signed-in only. The middleware guards everything under /api that is not
  // explicitly public (src/lib/supabase/middleware.ts), and this route is not
  // on that list - so a signed-out request is redirected to /signin before it
  // ever arrives. This check is the second lock: it is what holds if the
  // matcher ever changes, and it is the reason the route needs no middleware
  // edit at all.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const q = normalizeSuggestQuery(req.nextUrl.searchParams.get("q"));
  // Too short to search. Answered before the rate limiter so a stray keystroke
  // never spends a request out of someone's budget.
  if (!q) return NextResponse.json(EMPTY);

  const zip = (req.nextUrl.searchParams.get("zip") ?? "").trim().slice(0, 10);
  const cacheKey = `${zip}|${q.toLowerCase()}`;

  // A cache hit costs nothing outbound, so it does not spend the limiter
  // either: the budget below exists to protect Photon, not to meter reads of
  // our own memory.
  const cached = cacheGet(cacheKey);
  if (cached) return NextResponse.json({ suggestions: cached });

  // 60 a minute per user - roughly one debounced keystroke per second, which
  // no one sustains by hand but a script would blow through instantly. Same
  // atomic fixed-window rate_limit_hit RPC (migration 0068) the AI routes and
  // the parcel lookup use.
  //
  // FAILS OPEN, matching lookupParcelAction next door: nothing here is billed
  // or destructive, so a limiter hiccup must not cost a real homeowner their
  // address suggestions. Only an explicit `allowed === false` blocks.
  try {
    const admin = createAdminClient();
    const { data: allowed } = await admin.rpc("rate_limit_hit", {
      p_bucket: `addr-suggest:${user.id}`,
      p_limit: 60,
      p_window_seconds: 60,
    });
    // 200 with an empty list, not 429: to the person typing, "too fast" and
    // "nothing found" are the same non-event, and the input keeps working
    // either way. A 429 would only give the client an error state to render
    // for something that is not the homeowner's problem.
    if (allowed === false) return NextResponse.json(EMPTY);
  } catch (err) {
    console.error("address-suggest rate_limit_hit failed - allowing:", err);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTON_TIMEOUT_MS);
  try {
    const res = await fetch(photonSuggestUrl(q, zip || null), {
      signal: controller.signal,
      headers: {
        // Photon asks callers to identify themselves so they can reach a
        // misbehaving client instead of blocking a whole IP range.
        "User-Agent": "Hearth/1.0 (+https://hearth.build)",
        Accept: "application/json",
      },
      // Next would otherwise try to cache this in its own data cache, keyed on
      // a URL that changes with every keystroke. The in-memory cache above is
      // the one that should answer repeats.
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json(EMPTY);
    const suggestions = mapPhotonResults(await res.json());
    // An empty result is cached too. A misspelling gets retyped and re-sent,
    // and a miss costs the same outbound request a hit does.
    cacheSet(cacheKey, suggestions);
    return NextResponse.json({ suggestions });
  } catch (err) {
    // AbortError (the 3s timeout), DNS/network failure, a body that is not
    // JSON. All the same outcome: no suggestions, and the typed address still
    // goes through untouched.
    console.error("Photon address suggest failed:", err);
    return NextResponse.json(EMPTY);
  } finally {
    clearTimeout(timeout);
  }
}
