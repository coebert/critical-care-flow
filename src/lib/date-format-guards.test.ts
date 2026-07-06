import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "date-fns";
import { tzTooltip } from "./format-timestamp";

/**
 * Guard tests: our UI must consistently display DD/MM/YYYY (24-hour) on
 * every user-visible date. These tests fail fast if a future change
 * re-introduces US-style formats, unlocalised `toLocaleString`, or
 * abbreviated month tokens like `MMM` in a date rendered to the user.
 */

const ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) {
      out.push(p);
    }
  }
  return out;
}

const FILES = walk(ROOT);

/** Files intentionally exempt (auto-generated, third-party UI, storage keys). */
const EXEMPT = new Set<string>([
  join(ROOT, "routeTree.gen.ts"),
  join(ROOT, "integrations/supabase/types.ts"),
  join(ROOT, "integrations/supabase/client.ts"),
  join(ROOT, "components/ui/calendar.tsx"), // react-day-picker internals
  join(ROOT, "lib/format-timestamp.ts"),    // canonical tooltip helper (owns the UTC string)
]);

function readSources(): Array<{ path: string; text: string }> {
  return FILES.filter((f) => !EXEMPT.has(f)).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
}

describe("date format guards", () => {
  const sources = readSources();

  it("never renders MM/dd/yyyy (US) or yyyy/MM/dd via date-fns format()", () => {
    const bad: string[] = [];
    // Matches format("...MM/dd/yyyy...") or format("...yyyy/MM/dd...")
    const re = /format\s*\([^)]*["'`][^"'`]*(?:MM\/dd\/yyyy|yyyy\/MM\/dd)[^"'`]*["'`]/;
    for (const { path, text } of sources) {
      if (re.test(text)) bad.push(path);
    }
    expect(bad, `US/ISO-slash date formats found in:\n${bad.join("\n")}`).toEqual([]);
  });

  it("never uses `MMM` or `MMMM` month tokens in a full date format string", () => {
    // format("...dd MMM yyyy...") etc. — allowed only for chart bucket axes,
    // which currently use `MMM yyyy` (month-only). We forbid it when combined
    // with a day token.
    const bad: Array<{ path: string; match: string }> = [];
    const re = /format\s*\([^)]*["'`]([^"'`]*\b(?:dd|d)\b[^"'`]*\bMMM+\b[^"'`]*|[^"'`]*\bMMM+\b[^"'`]*\b(?:dd|d)\b[^"'`]*)["'`]/g;
    for (const { path, text } of sources) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) bad.push({ path, match: m[0] });
    }
    expect(
      bad,
      `Abbreviated month with day token found:\n${bad.map((b) => `${b.path}: ${b.match}`).join("\n")}`,
    ).toEqual([]);
  });

  it("never calls Date's toLocaleDateString / toLocaleTimeString without an explicit locale", () => {
    const bad: Array<{ path: string; line: number; text: string }> = [];
    const re = /\.toLocale(?:Date|Time)String\s*\(\s*\)/;
    for (const { path, text } of sources) {
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) bad.push({ path, line: i + 1, text: line.trim() });
      });
    }
    expect(
      bad,
      `Unlocalised toLocale*String() calls (would produce locale-dependent formats):\n${bad
        .map((b) => `${b.path}:${b.line}  ${b.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("every slash-separated date format uses dd/MM/yyyy (British ordering)", () => {
    // Only care about user-visible slash-separated dates. ISO keys like
    // "yyyy-MM-dd" (bucket keys, chart lookups) and month-only labels like
    // "MMM yyyy" are intentionally not user-visible dates and are skipped.
    const bad: Array<{ path: string; match: string }> = [];
    const re = /format\s*\([^,]+,\s*["'`]([^"'`]+)["'`]\s*\)/g;
    for (const { path, text } of sources) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const fmt = m[1];
        if (!fmt.includes("/")) continue;
        // Must start with dd/MM/yyyy — trailing time / suffix tokens allowed.
        if (!/^dd\/MM\/yyyy(\b|$)/.test(fmt) && !fmt.includes("dd/MM/yyyy")) {
          bad.push({ path, match: fmt });
        }
      }
    }
    expect(
      bad,
      `Non-DD/MM/YYYY slash-separated formats:\n${bad.map((b) => `${b.path}: "${b.match}"`).join("\n")}`,
    ).toEqual([]);
  });
});

describe("tzTooltip", () => {
  it("returns a deterministic UTC-anchored tooltip", () => {
    const iso = "2026-07-06T09:15:30.000Z";
    const t = tzTooltip(iso);
    expect(t).toContain("2026-07-06T09:15:30.000Z (UTC)");
    expect(t).toContain("local browser timezone");
  });

  it("handles Date instances", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(tzTooltip(d)).toContain("2026-01-02T03:04:05.000Z (UTC)");
  });

  it("returns the raw input for unparseable values", () => {
    expect(tzTooltip("not-a-date")).toBe("not-a-date");
  });
});

describe("date-fns dd/MM/yyyy produces British ordering", () => {
  it("day comes before month", () => {
    // 3 Feb 2026 must render as 03/02/2026, never 02/03/2026.
    const d = new Date(Date.UTC(2026, 1, 3, 12, 0, 0));
    const out = format(d, "dd/MM/yyyy");
    const [day, month, year] = out.split("/");
    expect(day).toBe("03");
    expect(month).toBe("02");
    expect(year).toBe("2026");
  });
});
