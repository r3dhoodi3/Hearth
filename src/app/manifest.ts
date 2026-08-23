import type { MetadataRoute } from "next";

// Web app manifest: what makes "Add to Home Screen" / "Install app" produce a
// real app icon that opens full-screen. Served at /manifest.webmanifest and
// linked from the root layout's metadata. Safari on iOS ignores the icons
// here and uses apple-icon.tsx instead; Android and desktop Chrome read this.
// start_url is the signed-in home: an installed app should open into the
// product, and the dashboard already bounces a signed-out visitor to /signin.
// The ?source=pwa on it is just an attribution marker (nothing reads it yet)
// so installed-app traffic can eventually be told apart from a browser tab.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Hearth",
    short_name: "Hearth",
    description:
      "Keep your house in good shape, know what needs attention, and reach a trustworthy pro when something breaks.",
    start_url: "/dashboard?source=pwa",
    scope: "/",
    display: "standalone",
    // No orientation lock: "portrait" fought anyone reading a document, a
    // quote photo, or the cost-forecast table sideways, and locking rotation
    // works against a device set to landscape for accessibility reasons.
    orientation: "any",
    background_color: "#fbf7f2",
    theme_color: "#fbf7f2",
    categories: ["lifestyle", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
      // Android's install prompt needs a real PNG in the 192/512 range - the
      // SVG above and the 180x180 apple-icon don't satisfy that. Same flat,
      // full-bleed artwork (src/app/icon-192.png, src/app/icon-512.png) works
      // for both purposes (see the comment in icon-192.png/route.tsx), listed
      // twice each: Next's Manifest type only accepts one purpose value per
      // entry, where the actual web manifest spec would allow the single
      // space-separated "any maskable".
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
