import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSeedLists } from "../src/seed.js";

async function seedDir(files: Record<string, string>): Promise<string> {
  const dir = join(tmpdir(), `plumbline-seeds-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("loadSeedLists", () => {
  it("loads the committed seed lists", async () => {
    const seeds = await loadSeedLists("seeds");
    // The committed list must stay in lockstep with this pin: five anchors,
    // each verified live against its stellar.toml before entering the list.
    expect(seeds.anchors.map((a) => [a.homeDomain, a.network])).toEqual([
      ["testanchor.stellar.org", "testnet"],
      ["stellar.moneygram.com", "pubnet"],
      ["mykobo.co", "pubnet"],
      ["anclap.com", "pubnet"],
      ["clpx.finance", "pubnet"],
    ]);
    for (const anchor of seeds.anchors) {
      expect(anchor.source.length).toBeGreaterThan(10);
      expect(anchor.displayName).toBeTruthy();
    }
    expect(seeds.optOuts).toEqual([]);
  });

  it("rejects a seed anchor with no source — every entry is reviewed", async () => {
    const dir = await seedDir({
      "anchors.yaml": "anchors:\n  - homeDomain: anchor.example.com\n    network: pubnet\n",
      "optout.yaml": "optouts: []\n",
    });
    await expect(loadSeedLists(dir)).rejects.toThrow(/source/);
  });

  it("rejects an opt-out with no note — the audit trail is the point", async () => {
    const dir = await seedDir({
      "anchors.yaml": "anchors: []\n",
      "optout.yaml": "optouts:\n  - homeDomain: anchor.example.com\n",
    });
    await expect(loadSeedLists(dir)).rejects.toThrow(/note/);
  });

  it("defaults a missing network to pubnet", async () => {
    const dir = await seedDir({
      "anchors.yaml": "anchors:\n  - homeDomain: anchor.example.com\n    source: reviewed\n",
      "optout.yaml": "optouts: []\n",
    });
    const seeds = await loadSeedLists(dir);
    expect(seeds.anchors[0]?.network).toBe("pubnet");
  });
});
