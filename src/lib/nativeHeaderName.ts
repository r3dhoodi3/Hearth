// The one place the native-app request header is NAMED, deliberately in a
// module with NO "use client" directive so both sides of the app can read it.
//
// WHY THIS FILE EXISTS (red team, 2026-09-08). The constant used to live only
// in src/lib/platform.ts, which starts with "use client". Importing a plain
// value out of a "use client" module from SERVER code does not give you the
// value: Next replaces that module with client references at the server
// boundary, so src/lib/nativeClientHeader.ts read NATIVE_CLIENT_HEADER as
// `undefined`, called headers().get(undefined), and got null back on every
// single request. That silently turned the whole Apple 3.1.1 / Google Play
// Billing gate into a no-op: a request carrying "X-OakTend-Client: ios-app"
// sailed through startPlusCheckoutAction and landed on Stripe Checkout, which
// is exactly the thing the gate exists to refuse. Verified live on 2026-09-08
// (the header arrived on the action POST; the action still created a Stripe
// session).
//
// Keep this module free of "use client" and free of server-only imports: it is
// read from BOTH sides on purpose, and the whole point is that one string
// cannot drift between the client that stamps the header and the server that
// checks it.
export const NATIVE_CLIENT_HEADER = "X-OakTend-Client";
