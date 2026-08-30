"use client";

import { useState } from "react";

// CR4#3: a ready-to-print PNG for a truck magnet or an invoice footer -
// not just the bare QR code src/app/pro/profile/QrCodeCard.tsx already
// offers on the profile page, but that QR plus the short public-profile
// link and the business name composed into one image, so nothing has to be
// hand-typed onto a decal. Reuses the same `qrcode` package QrCodeCard
// already depends on (no new dependency); the composition itself is a plain
// <canvas>, done entirely client-side like QrCodeCard's own data URL.
//
// `qrcode` is imported dynamically inside the click handler, same reasoning
// as QrCodeCard: nobody pays for the encoder's bytes until they actually
// tap this button.
const WIDTH = 1400;
const HEIGHT = 700;
const QR_SIZE = 560;
const MARGIN = 70;

// Shrinks the font until `text` fits `maxWidth`, floor 24px so a very long
// business name still reads rather than vanishing to nothing.
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  weight: string
): number {
  let size = startSize;
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 24) {
    size -= 4;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  }
  return size;
}

export default function PrintQrButton({
  url,
  businessName,
}: {
  url: string;
  businessName: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function handlePrint() {
    setPending(true);
    setError(false);
    try {
      const { default: QRCode } = await import("qrcode");
      const qrDataUrl = await QRCode.toDataURL(url, {
        width: QR_SIZE,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#1c1917", light: "#ffffff" },
      });

      const qrImg = new Image();
      await new Promise<void>((resolve, reject) => {
        qrImg.onload = () => resolve();
        qrImg.onerror = () => reject(new Error("QR image failed to load"));
        qrImg.src = qrDataUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const qrY = (HEIGHT - QR_SIZE) / 2;
      ctx.drawImage(qrImg, MARGIN, qrY, QR_SIZE, QR_SIZE);

      const textX = MARGIN + QR_SIZE + MARGIN;
      const textMaxWidth = WIDTH - textX - MARGIN;
      ctx.fillStyle = "#1c1917";
      ctx.textBaseline = "alphabetic";

      fitFont(ctx, businessName, textMaxWidth, 64, "bold");
      ctx.fillText(businessName, textX, 260);

      ctx.font = "36px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#57534e";
      ctx.fillText("Find us on Hearth", textX, 330);

      const shortLink = url.replace(/^https?:\/\//, "");
      fitFont(ctx, shortLink, textMaxWidth, 40, "bold");
      ctx.fillStyle = "#1c1917";
      ctx.fillText(shortLink, textX, 400);

      ctx.font = "28px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#78716c";
      ctx.fillText("Scan to see reviews, licence, and request a quote.", textX, 460);

      const pngUrl = canvas.toDataURL("image/png");
      const slug =
        businessName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "hearth";
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `hearth-qr-print-${slug}.png`;
      a.click();
    } catch {
      // Generation failing (canvas unavailable, the dynamic import throwing)
      // shows an inline error instead of silently doing nothing - unlike
      // QrCodeCard's own quiet "the row just doesn't render", this is an
      // explicit button tap and deserves a visible outcome.
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-t border-stone-100 pt-4 dark:border-white/10">
      <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Print your QR code
      </h3>
      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
        A ready-to-print PNG with your QR code, business name, and Hearth
        link in one image, sized for a truck magnet or an invoice footer.
      </p>
      <button
        type="button"
        onClick={handlePrint}
        disabled={pending}
        className="btn-secondary mt-2 text-sm"
      >
        {pending ? "Preparing…" : "Print your QR code"}
      </button>
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Couldn&apos;t generate the image. Try again.
        </p>
      )}
    </div>
  );
}
