import type { MetadataRoute } from "next";

// Web app manifest: what makes "Add to Home Screen" / "Install app" produce a
// real app icon that opens full-screen. Served at /manifest.webmanifest and
// linked from the root layout's metadata. Safari on iOS ignores the icons
// here and uses apple-icon.tsx instead; Android and desktop Chrome read this.
// start_url is the signed-in home: an installed app should open into the
// product, and the dashboard already bounces a signed-out visitor to /signin.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hearth",
    short_name: "Hearth",
    description:
      "Keep your house in good shape, know what needs attention, and reach a trustworthy pro when something breaks.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#fbf7f2",
    theme_color: "#fbf7f2",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
