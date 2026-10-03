import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { cx } from "../cx";
import "./QrCode.css";

export interface QrCodeProps {
  /** The text to encode, for example a client's whole config. */
  value: string;
  /** Accessible name, for example "QR code for laptop's config". */
  label: string;
  /** Width and height in px (default 220). */
  size?: number;
  className?: string;
}

/** The quiet zone the QR standard asks for, in modules. */
const MARGIN = 4;

/** One SVG path for the dark modules, merging each row's runs. Null when the text does not fit. */
function draw(value: string): { n: number; d: string } | null {
  const qr = qrcode(0, "M");
  try {
    qr.addData(value);
    qr.make();
  } catch {
    return null; // "code length overflow": more than a QR code holds
  }
  const count = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; ) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < count && qr.isDark(r, c + run)) run++;
      d += `M${c + MARGIN} ${r + MARGIN}h${run}v1h-${run}z`;
      c += run;
    }
  }
  return { n: count + 2 * MARGIN, d };
}

/**
 * A QR code as crisp SVG, dark on white in both themes (phone cameras need
 * the contrast). Used for a client's config and the app's install link.
 */
export function QrCode({ value, label, size = 220, className }: QrCodeProps) {
  const art = useMemo(() => draw(value), [value]);
  if (!art) {
    return (
      <p className={cx("qr qr--too-long", className)} style={{ width: size }}>
        This is too long for a QR code. Use the download or copy instead.
      </p>
    );
  }
  return (
    <svg
      role="img"
      aria-label={label}
      className={cx("qr", className)}
      width={size}
      height={size}
      viewBox={`0 0 ${art.n} ${art.n}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={art.n} height={art.n} fill="#ffffff" />
      <path d={art.d} fill="#000000" />
    </svg>
  );
}
