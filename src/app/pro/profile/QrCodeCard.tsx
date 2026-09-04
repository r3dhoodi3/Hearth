"use client";

import { useEffect, useState } from "react";

// QR code for the pro's public /p/<id> page. Free for EVERY pro, member or
// not: the whole point is getting the page in front of customers, so pros can
// print it on trucks, invoices, and business cards. Generated entirely
// client-side (the `qrcode` package renders to a data URL); nothing is
// uploaded or stored.
//
// `qrcode` is imported dynamically inside the effect rather than at module
// scope. A static import puts the whole encoder in this route's first-load
// JS, where it is downloaded and parsed by every pro who opens the profile
// page even though the only thing that ever touches it is the one call below.
// The dynamic import makes it its own chunk, fetched after mount, and the
// card already renders nothing until the data URL exists, so nothing about
// what the pro sees changes.
export default function QrCodeCard({
  url,
  businessName,
}: {
  url: string;
  businessName: string;
}) {
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    // url is empty until the browser origin is known (see PublicPageCard).
    if (!url) return;
    let cancelled = false;
    // 480px with a 2-module quiet zone scans reliably even printed at
    // business-card size.
    import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(url, {
          width: 480,
          margin: 2,
          errorCorrectionLevel: "M",
          color: { dark: "#1c1917", light: "#ffffff" },
        })
      )
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        // Generation failing is non-fatal; the row simply doesn't render.
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!dataUrl) return null;

  const slug =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page";

  return (
    <div className="flex items-center gap-4 border-t border-stone-100 pt-4 dark:border-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dataUrl}
        alt={`QR code linking to ${businessName} on OakTend`}
        className="h-24 w-24 rounded-lg border border-stone-200 bg-white dark:border-white/10"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Your QR code</p>
        <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
          Put it on your truck, invoices, and business cards. Scanning it opens
          your page.
        </p>
        <a
          href={dataUrl}
          download={`oaktend-qr-${slug}.png`}
          className="btn-secondary mt-2 text-xs px-3 py-1.5"
        >
          Download QR (PNG)
        </a>
      </div>
    </div>
  );
}
