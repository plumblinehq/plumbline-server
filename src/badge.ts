/**
 * Shields-compatible flat badge SVG, generated without any library — the
 * format is a fixed template plus a color and two labels. The route serves
 * this with a long cache TTL, so the output must be deterministic and the
 * anchor's home domain must be escaped before it ever reaches the markup.
 */

const COLOR_BY_SCORE: Array<{ min: number; color: string }> = [
  { min: 0.9, color: "#4c1" }, // brightgreen
  { min: 0.7, color: "#97CA00" }, // green
  { min: 0.5, color: "#dfb317" }, // yellow
  { min: 0.3, color: "#fe7d37" }, // orange
  { min: -Infinity, color: "#e05d44" }, // red
];

const NO_DATA_COLOR = "#555"; // grey, shields' conventional "inactive"

const LABEL = "plumbline";
const LABEL_WIDTH = 64;

/** Score in [0, 1] → shields color; null means "no complete run yet". */
export function badgeColor(score: number | null): string {
  if (score === null) {
    return NO_DATA_COLOR;
  }
  return COLOR_BY_SCORE.find((entry) => score >= entry.min)?.color ?? NO_DATA_COLOR;
}

/** The message shown on the badge: a percentage, or "no data". */
export function badgeMessage(score: number | null): string {
  if (score === null) {
    return "no data";
  }
  return `${Math.round(score * 100)}%`;
}

/**
 * Build the badge SVG for an anchor. The value shown is the score as a
 * percentage, or "no data" before the anchor's first complete run. The
 * home domain is user input and is escaped before it reaches the markup.
 */
export function badgeSvg(homeDomain: string, score: number | null): string {
  const color = badgeColor(score);
  const rightText = badgeMessage(score);
  // Approximate text width: shields measures glyphs; 6.5px per character at
  // the 11px font size is close enough that the padding hides the error.
  const rightWidth = Math.max(76, Math.ceil(rightText.length * 6.5) + 14);
  const totalWidth = LABEL_WIDTH + rightWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(LABEL)}: ${escapeXml(homeDomain)} ${escapeXml(rightText)}">
  <title>${escapeXml(LABEL)}: ${escapeXml(homeDomain)} ${escapeXml(rightText)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${LABEL_WIDTH}" height="20" fill="#555"/>
    <rect x="${LABEL_WIDTH}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${Math.floor(LABEL_WIDTH / 2)}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(LABEL)}</text>
    <text x="${Math.floor(LABEL_WIDTH / 2)}" y="14">${escapeXml(LABEL)}</text>
    <text x="${LABEL_WIDTH + Math.floor(rightWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(rightText)}</text>
    <text x="${LABEL_WIDTH + Math.floor(rightWidth / 2)}" y="14">${escapeXml(rightText)}</text>
  </g>
</svg>`;
}

/** Escape text for safe embedding in XML/SVG — a domain is user input. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}