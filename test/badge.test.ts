import { describe, expect, it } from "vitest";
import { badgeColor, badgeMessage, badgeSvg, escapeXml } from "../src/badge.js";

describe("badgeColor", () => {
  it("maps scores onto the shields palette", () => {
    expect(badgeColor(0.95)).toBe("#4c1");
    expect(badgeColor(0.9)).toBe("#4c1");
    expect(badgeColor(0.85)).toBe("#97CA00");
    expect(badgeColor(0.7)).toBe("#97CA00");
    expect(badgeColor(0.6)).toBe("#dfb317");
    expect(badgeColor(0.4)).toBe("#fe7d37");
    expect(badgeColor(0.2)).toBe("#e05d44");
    expect(badgeColor(0)).toBe("#e05d44");
  });

  it("uses grey for anchors with no complete run", () => {
    expect(badgeColor(null)).toBe("#555");
  });
});

describe("badgeMessage", () => {
  it("renders a percentage", () => {
    expect(badgeMessage(0.8333)).toBe("83%");
    expect(badgeMessage(1)).toBe("100%");
    expect(badgeMessage(0)).toBe("0%");
  });

  it("renders no data for anchors without a run", () => {
    expect(badgeMessage(null)).toBe("no data");
  });
});

describe("badgeSvg", () => {
  it("renders a complete SVG with the score percentage", () => {
    const svg = badgeSvg("anclap.com", 0.8333);
    expect(svg).toContain('aria-label="plumbline: anclap.com 83%"');
    expect(svg).toContain("<title>plumbline: anclap.com 83%</title>");
    expect(svg).toContain('fill="#97CA00"'); // 0.83 → green
    expect(svg).toMatch(/^<svg xmlns=/);
    expect(svg).toMatch(/<\/svg>$/);
  });

  it("renders no data for an unscanned anchor", () => {
    const svg = badgeSvg("fresh.example.com", null);
    expect(svg).toContain("no data");
    expect(svg).toContain('fill="#555"');
  });

  it("escapes user input before it reaches the markup", () => {
    const svg = badgeSvg('"><script>alert(1)</script>', 0.5);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain('aria-label="plumbline: "');
  });
});

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`<a b="c" & 'd'>`)).toBe("&lt;a b=&quot;c&quot; &amp; &apos;d&apos;&gt;");
  });
});