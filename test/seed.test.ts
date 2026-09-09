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
    expect(seeds.anchors).toEqual([
      {
        homeDomain: "testanchor.stellar.org",
        network: "testnet",
        displayName: "SDF Test Anchor",
        source: "stellar.org developers docs (SDF-operated test anchor)",
      },
    ]);
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
