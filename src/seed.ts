/**
 * The seed lists, per plumbline-architecture.md §6.5: the initial anchor list
 * comes from published sources, not a hand-typed guess, and every entry
 * records where it came from. Both files are committed so every addition is
 * reviewable, and the opt-out list is the documented, auditable mechanism
 * behind the politeness boundary — any anchor that asks to be removed is
 * removed, with the note kept.
 */
import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface SeedAnchor {
  homeDomain: string;
  network: "pubnet" | "testnet";
  displayName?: string;
  /** Where this entry came from, e.g. the directory it was verified against. */
  source: string;
}

export interface SeedOptOut {
  homeDomain: string;
  /** Why the anchor was removed, kept for the audit trail. */
  note: string;
}

export interface SeedLists {
  anchors: SeedAnchor[];
  optOuts: SeedOptOut[];
}

function parseSeedList<T extends "anchors" | "optouts">(
  file: string,
  body: string,
  key: T,
): T extends "anchors" ? SeedAnchor[] : SeedOptOut[] {
  const parsed: unknown = YAML.parse(body);
  // Both seed files carry a single named top-level key (anchors: / optouts:)
  // so the YAML is self-describing and future metadata cannot be confused
  // with entries.
  if (parsed === null || parsed === undefined) {
    return [] as never;
  }
  const entries = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) {
    throw new Error(`${file}: expected a top-level "${key}" list`);
  }
  return entries.map((entry) => {
    if (typeof entry.homeDomain !== "string" || entry.homeDomain === "") {
      throw new Error(`${file}: every entry needs a non-empty homeDomain`);
    }
    if (file.includes("optout")) {
      if (typeof entry.note !== "string" || entry.note === "") {
        throw new Error(`${file}: ${entry.homeDomain} needs a non-empty note`);
      }
      return { homeDomain: entry.homeDomain, note: entry.note } as never;
    }
    const network = entry.network === "testnet" ? "testnet" : "pubnet";
    if (typeof entry.source !== "string" || entry.source === "") {
      throw new Error(`${file}: ${entry.homeDomain} needs a source; every seed entry is reviewed`);
    }
    const source = entry.source;
    return {
      homeDomain: entry.homeDomain,
      network,
      displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
      source,
    } as never;
  });
}

export async function loadSeedLists(dir = "seeds"): Promise<SeedLists> {
  const [anchorsBody, optOutBody] = await Promise.all([
    readFile(`${dir}/anchors.yaml`, "utf8"),
    readFile(`${dir}/optout.yaml`, "utf8"),
  ]);
  return {
    anchors: parseSeedList("anchors.yaml", anchorsBody, "anchors"),
    optOuts: parseSeedList("optout.yaml", optOutBody, "optouts"),
  };
}
