import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ToastProvider from "@/components/ToastProvider";
import FlashToast from "@/components/FlashToast";
import { LAUNCH_CITY_NAMES } from "@/lib/serviceArea";

// KEEP THIS FILE FREE OF cookies() AND headers().
//
// The root layout wraps every route in the app, so a single request-scoped
// read here opts the ENTIRE build out of static generation - every public
// marketing and SEO page included. This layout used to call readFlash(), which
// calls cookies(), and the result was a build with zero static pages. The
// flash toast now reads its own cookie on the client (see FlashToast below);
// the theme is applied by the inline script in <head>, which runs in the
// browser and touches nothing server-side; the fonts and the JSON-LD are
// build-time constants. Anything new added here has to stay in that category.

// Self-hosted via next/font, exposed as a CSS variable so Tailwind's
// font-sans (see tailwind.config.ts) picks it up everywhere.
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });

// Runs before first paint so a saved dark theme never flashes light. Kept as
// a plain string (not a component) because it must execute synchronously in
// <head>. Dark is strictly opt-in: light is the default for everyone, and the
// class is added only when the user has actually chosen dark in ThemeToggle.
// The OS preference is deliberately not consulted - a visitor whose phone is
// in dark mode still gets Hearth's light look until they ask otherwise.
const themeInit = `(function () {
  try {
    if (localStorage.getItem("hearth-theme") !== "dark") return;
    document.documentElement.classList.add("dark");
    // Match the browser/status-bar tint to the restored theme. The
    // theme-color meta is emitted by Next's viewport export, which may not
    // have rendered yet when this runs, so only update an existing tag -
    // never create a second one. ThemeToggle's mount effect syncs it when
    // this finds nothing.
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", "#1c1917");
  } catch (e) {}
})();`;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Organization JSON-LD, so search results can attribute pages to Hearth as a
// business rather than guessing from the page title. Mirrors the Service
// JSON-LD CityLandingPage builds per city (src/components/CityLandingPage.tsx):
// same reasoning, root-level scope. areaServed is built from the same
// LAUNCH_CITY_NAMES the ZIP gates and the pro checkboxes read, so the
// structured data can never claim a city Hearth has stopped (or not yet
// started) serving. Only two of these cities have a landing page of their own;
// the rest are served without one, which is fine here - this is a service-area
// claim, not a sitemap.
//
// This is the ONE Organization node in the app. The landing page used to emit
// a second one (name/url/logo) alongside its WebApplication, which left two
// competing descriptions of the same business on the highest-value page; the
// logo moved here instead, and the stable @id gives anything that wants to
// point at Hearth-the-organization something to reference.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}#organization`,
  name: "Hearth",
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  areaServed: LAUNCH_CITY_NAMES.map((city) => ({
    "@type": "City",
    name: `${city}, CA`,
  })),
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Hearth: Your home, looked after",
    template: "%s | Hearth",
  },
  description:
    "Keep your house in good shape, know what needs attention, store your home docs, and reach a trustworthy pro when something breaks.",
  openGraph: {
    siteName: "Hearth",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
  // Installable on phones. The manifest (src/app/manifest.ts) covers Android
  // and desktop Chrome; Safari on iOS ignores manifest icons and reads the
  // apple-* tags below plus src/app/apple-icon.tsx instead. "Add to Home
  // Screen" then installs a real Hearth icon that opens full-screen with no
  // browser chrome, which is the mobile counterpart of SEO: the app lives on
  // the home screen rather than in a bookmark.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Hearth",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

// viewport-fit=cover is required so env(safe-area-inset-*) resolves to a
// non-zero value on notched iPhones. The bottom tab bars (Nav / ProNav) and
// the floating docks pad themselves by that inset, so without cover the
// safe-area padding silently collapses to 0 and controls sit under the notch
// / home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Tints the iOS status bar / Android toolbar to the header background so
  // the installed app and the browser tab read as one surface. Value matches
  // the light header (bg-bark-50) in Nav.tsx.
  //
  // A single static color, not a prefers-color-scheme pair: the page itself
  // is light unless the user opted into dark, so keying the tint off the OS
  // put dark iPhone chrome above a light page. ThemeToggle rewrites this tag
  // to #1c1917 when dark is on (and the inline themeInit script does the same
  // on reload), which is the only thing that should darken it.
  themeColor: "#fbf7f2",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the theme script adds .dark to <html> before
    // React hydrates, which is an expected server/client mismatch.
    // The font variable + font-sans live on <html>, not <body>: Tailwind's
    // preflight declares font-family on html, and a var() undefined at that
    // level invalidates the whole declaration, silently dropping the site to
    // the browser's default serif.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} font-sans`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
      </head>
      <body>
        <ToastProvider>
          {children}
          <FlashToast />
        </ToastProvider>
      </body>
    </html>
  );
}
