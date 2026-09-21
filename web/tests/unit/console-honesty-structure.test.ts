/**
 * THE HONESTY STRUCTURE CHECK — "no count is rendered for a field the payload did
 * not carry", as a FAILING-BY-DESIGN control.
 *
 * WHERE THIS COMES FROM. LANE 2 (worker2) attacked the console's closed-state
 * claim and found twenty call sites rendering `?? 0` for counts a payload may not
 * have carried, plus one site substituting a DIFFERENT quantity under the same
 * label (`totals.in_scope ?? populations.inconsistent`). Their detector lives at
 * `.prime/handoff/verify-lane/closed-state/closed-state.test.ts` (4 pass / 1 fail,
 * and the failure IS the finding). This file adopts it into our own tree, so the
 * check runs and fails here rather than only in a verification scratch directory.
 *
 * WHAT IT ASSERTS — structure, plus the practice rule. Lane 2's own self-correction
 * is the reason: their first version asserted the WORDING of our doc comments and
 * broke the moment we edited them, which proves nothing about behaviour. So:
 *
 *   1. STRUCTURE: the mechanisms exist — `Absent`, and `NumberCard`'s
 *      value-or-absentReason union, which is what forces a call site to decide.
 *   2. PRACTICE: no numeric-literal fallback (`?? 0`, `|| 0`, `?? 1`, …) anywhere
 *      in this feature, except entries allow-listed BY NAME WITH A REASON.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING, and that is deliberate. The doctrine in
 * `idp-bits.tsx` NAMES the banned pattern while forbidding it ("`totals.x ?? 0` is
 * banned"), and a raw-text scan flags the explanation as the offence. The wrong fix
 * is to reword the doctrine until it slips past the scanner — that deletes the
 * documentation to satisfy a proxy, and the prohibition becomes invisible to the
 * next reader. So the checker ignores comments instead, and CONTROL 3 below proves
 * the checker still fails on real code.
 *
 * ITS LIMIT, STATED PLAINLY: this catches a fallback that is a NUMERIC LITERAL. It
 * cannot catch a fallback that is a different VARIABLE (`a ?? b` where `b` is some
 * other count) — that is a judgement about meaning, and no regex makes it. Two
 * consequences follow, and both are load-bearing:
 *   - the compiler is the real enforcement for the optional fields: `idp-types.ts`
 *     types every map-derived count as OPTIONAL, so `totals.responded` no longer
 *     typechecks where a `number` is required; and
 *   - the absence BRANCHES are proven behaviourally, not here: see the e2e tests
 *     "a payload that omits a count shows the absence, not a zero" and
 *     "a refused read renders no count card at all".
 *
 * RUNNER: `bun test tests/unit/console-honesty-structure.test.ts` (see the sibling
 * `consent-classification.test.ts` for why the web package's only runner is bun).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_FAILURE_KINDS,
  FAILURE_SURFACE,
  IdpReadError,
  observationStamp,
  observedSurface,
  toIdpFailure,
} from "../../src/features/admin/idp-source";

const FEATURE = join(import.meta.dir, "../../src/features/admin");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Block and line comments removed, so the doctrine may NAME the banned pattern. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix: string) =>
        prefix + " ".repeat(match.length - prefix.length),
    );
}

export type Offence = { file: string; line: number; text: string };

/** Every numeric-literal fallback: `?? 0`, `?? 1`, `|| 0`, … */
export function numericFallbacks(label: string, source: string): Offence[] {
  const pattern = /\?\?\s*-?\d|\|\|\s*0\b/;
  return stripComments(source)
    .split("\n")
    .map((text, index) => ({ file: label, line: index + 1, text: text.trim() }))
    .filter((row) => pattern.test(row.text));
}

/**
 * Sites where a missing key is legitimate ARITHMETIC over rows rather than a
 * rendered fact — lane 2's allow-list, with its reason.
 *
 * KEYED BY THE OFFENDING EXPRESSION, NOT BY `file:line`, and that is a correction
 * this check made to itself: it first used lane 2's line-number key, which then
 * failed because an unrelated doc-comment edit above the line shifted it from 78
 * to 79. A line number is not a property of the code — it changes whenever
 * anything above it changes — so that key produced a FALSE FAILURE on an edit that
 * touched no logic. The snippet IS the property the reason is about, and the test
 * below keeps the entry narrow enough that another fallback in the same file is
 * still a violation.
 */
const ALLOWED: { file: string; snippet: string; reason: string }[] = [
  {
    file: "idp-fixture-builders.ts",
    snippet: "(row[state] ?? 0)",
    reason:
      "sums per-state row counts inside a staged fixture; a missing key means zero rows",
  },
];

describe("STRUCTURE — the honesty mechanisms exist and are wired", () => {
  test("the Absent primitive exists and the panels use it", () => {
    const bits = readFileSync(join(FEATURE, "ui/idp-bits.tsx"), "utf8");
    expect(bits).toMatch(/export function Absent/);
    const panels = [
      "ConsentPanel",
      "ClientsPanel",
      "AuditPanel",
      "HealthPanel",
    ];
    for (const panel of panels) {
      const text = readFileSync(join(FEATURE, `ui/${panel}.tsx`), "utf8");
      expect(text, `${panel} must render an absence`).toMatch(/<Absent/);
    }
  });

  test("NumberCard forces a decision: value OR absentReason, never a bare number", () => {
    const bits = readFileSync(join(FEATURE, "ui/idp-bits.tsx"), "utf8");
    const start = bits.indexOf("export function NumberCard");
    expect(start).toBeGreaterThan(-1);
    const signature = bits.slice(start, start + 900);
    expect(signature).toMatch(/label:/);
    expect(signature).toMatch(/note:/);
    // The union is the mechanism: a call site cannot pass a number without
    // choosing `value`, and cannot report a missing field without a reason.
    expect(signature).toMatch(/absentReason: string/);
    expect(signature).toMatch(/value: number \| string/);
    expect(signature).toMatch(/data-value/);
  });

  test("CountCard requires an absence reason (a required prop, not a convention)", () => {
    const bits = readFileSync(join(FEATURE, "ui/idp-bits.tsx"), "utf8");
    const start = bits.indexOf("export function CountCard");
    expect(start).toBeGreaterThan(-1);
    const signature = bits.slice(start, start + 700);
    expect(signature).toMatch(/absentReason: string;/);
    expect(signature).toMatch(/value: number \| undefined;/);
  });

  test("the map-derived counts are OPTIONAL in the types (the compiler's part)", () => {
    const types = readFileSync(join(FEATURE, "idp-types.ts"), "utf8");
    for (const field of [
      "in_scope?:",
      "responded?:",
      "subjects?:",
      "clients?:",
    ]) {
      expect(types, `${field} must be optional`).toContain(field);
    }
    expect(types).toMatch(/export type IdpOutOfScope/);
    expect(types).toMatch(/rows\?: number;/);
  });

  test("the closed state is rendered by exactly one component", () => {
    const page = readFileSync(join(FEATURE, "ui/AdminConsolePage.tsx"), "utf8");
    expect(page).toMatch(/<IdpClosedNotice/);
  });

  test("a refusal is not retried", () => {
    const hooks = readFileSync(join(FEATURE, "use-idp-admin.ts"), "utf8");
    expect(hooks).toMatch(/retry: false/);
  });
});

describe("PRACTICE — no count is rendered for a field the payload did not carry", () => {
  test("every numeric-literal fallback is absent or allow-listed with a reason", () => {
    const offences = sourceFiles(FEATURE)
      .flatMap((path) =>
        numericFallbacks(
          path.slice(FEATURE.length + 1),
          readFileSync(path, "utf8"),
        ),
      )
      .filter(
        (hit) =>
          !ALLOWED.some(
            (allowed) =>
              allowed.file === hit.file && hit.text.includes(allowed.snippet),
          ),
      );
    // The offender list IS the finding: a bare count is not actionable.
    expect(
      offences.map((o) => `${o.file}:${o.line}  ${o.text.slice(0, 84)}`),
    ).toEqual([]);
  });

  test("CONTROL 1 — the detector fails on a planted offender", () => {
    const planted = "value={data.totals.responded ?? 0}";
    expect(numericFallbacks("planted.tsx", planted)).toHaveLength(1);
    expect(numericFallbacks("planted.tsx", "const n = x || 0;")).toHaveLength(
      1,
    );
    expect(
      numericFallbacks("planted.tsx", "value={data.totals.ok ?? 1}"),
    ).toHaveLength(1);
  });

  test("CONTROL 2 — the doctrine may NAME the banned pattern in a comment", () => {
    const named =
      "// never write `totals.x ?? 0`, and never `|| 0`\nconst a = 1;";
    expect(numericFallbacks("doctrine.tsx", named)).toEqual([]);
    const block =
      "/**\n * `totals.x ?? 0` renders a zero for a missing field\n */";
    expect(numericFallbacks("doctrine.tsx", block)).toEqual([]);
  });

  test("CONTROL 3 — and it still fails on real code beside that comment", () => {
    const both = "// `totals.x ?? 0` is banned\nconst v = data.totals.ok ?? 0;";
    expect(numericFallbacks("mixed.tsx", both)).toHaveLength(1);
  });

  test("the allow-list names a reason for every entry (no blank permissions)", () => {
    expect(ALLOWED.length).toBeGreaterThan(0);
    for (const entry of ALLOWED) {
      expect(entry.file).toMatch(/^[\w.-]+\.tsx?$/);
      expect(
        entry.snippet.length,
        `${entry.file} needs a snippet`,
      ).toBeGreaterThan(4);
      expect(
        entry.reason.length,
        `${entry.file} needs a real reason`,
      ).toBeGreaterThan(20);
    }
  });

  test("and the allow-list is not a blanket permission for its file", () => {
    // The snippet must be narrow enough that ANOTHER numeric fallback in the same
    // file is still a violation: an allow-list entry is a permission for one
    // expression, not an exemption for a file.
    const planted = "const other = data.totals.ok ?? 0;";
    const unforgiven = numericFallbacks(
      "idp-fixture-builders.ts",
      planted,
    ).filter(
      (hit) =>
        !ALLOWED.some(
          (allowed) =>
            allowed.file === hit.file && hit.text.includes(allowed.snippet),
        ),
    );
    expect(unforgiven).toHaveLength(1);
  });
});

/**
 * ONE STATE MACHINE, ONE TABLE, BOTH SURFACES.
 *
 * LANE 2 found this implemented twice and extended once: `IdpFailureKind` declares
 * `restricted` (403) and the classifier produces it, the NOTICE knew it
 * ("Restricted"), and the HEADER did not — so a 403 rendered "Restricted" in one
 * place and "does not match any state the console knows" in the other. The same
 * event, two surfaces, contradictory, and it is a post-admission state, so it
 * appears the moment admission lands.
 *
 * The fix is structural: ONE exhaustive `Record<IdpFailureKind, …>`
 * (`FAILURE_SURFACE`) that both surfaces read, so a new kind that only one surface
 * understands fails to COMPILE. These tests cover the runtime half — every kind
 * present, and the two surfaces telling the same story.
 */
describe("ONE TABLE — both surfaces agree for every failure kind", () => {
  test("every kind has exactly one entry, and the table is exhaustive", () => {
    expect(ALL_FAILURE_KINDS.length).toBeGreaterThan(0);
    // Exhaustiveness is enforced by the type; this pins it at runtime too.
    expect(new Set(ALL_FAILURE_KINDS).size).toBe(ALL_FAILURE_KINDS.length);
    for (const kind of ALL_FAILURE_KINDS) {
      expect(typeof FAILURE_SURFACE[kind].title).toBe("string");
    }
  });

  test("THE DEFECT'S OWN CASE: 403 is in the table, and both surfaces name it", () => {
    const failure = toIdpFailure(
      new IdpReadError({
        kind: "restricted",
        path: "/api/idp/clients",
        status: 403,
        evidence:
          'HTTP 403 · "restricted: client nextcrm is not in your scope"',
      }),
    );
    // The notice's title comes from the table…
    expect(failure.title).toBe(FAILURE_SURFACE.restricted.title);
    // …and the header's sentence comes from the SAME entry, so the two cannot
    // disagree the way they did before the fix.
    const header = observedSurface({
      kind: "live",
      isPending: false,
      isError: true,
      error: new IdpReadError({
        kind: "restricted",
        path: "/api/idp/clients",
        status: 403,
        evidence: "HTTP 403",
      }),
      hasData: false,
      at: "2026-09-22T17:40:00.000Z",
    });
    expect(header.sentence).toBe(FAILURE_SURFACE.restricted.headerSentence);
    expect(header.sentence).not.toContain("does not match any state");
    expect(FAILURE_SURFACE.restricted.title).toBe("Restricted");
  });

  test("both surfaces tell the same story for EVERY kind", () => {
    for (const kind of ALL_FAILURE_KINDS) {
      const error = new IdpReadError({
        kind,
        path: "/api/idp/health",
        status: null,
        evidence: `planted ${kind}`,
      });
      const failure = toIdpFailure(error);
      const header = observedSurface({
        kind: "live",
        isPending: false,
        isError: true,
        error,
        hasData: false,
        at: "2026-09-22T17:40:00.000Z",
      });
      // Same title, both derived from the one entry.
      expect(failure.title, `${kind} title`).toBe(FAILURE_SURFACE[kind].title);
      // The header sentence is that entry's sentence, and it is not the fallback.
      expect(header.sentence, `${kind} header`).toBe(
        FAILURE_SURFACE[kind].headerSentence,
      );
      expect(header.outcome, `${kind} outcome`).toBe(
        FAILURE_SURFACE[kind].outcome,
      );
      // Every entry carries words for both surfaces; no blank half. A TITLE is
      // short by nature ("Restricted" is 10 characters), so it is held to a title's
      // bar and the prose fields to a sentence's.
      expect(
        FAILURE_SURFACE[kind].title.length,
        `${kind}.title`,
      ).toBeGreaterThan(5);
      for (const field of ["meaning", "nextStep", "headerSentence"] as const) {
        expect(
          FAILURE_SURFACE[kind][field].length,
          `${kind}.${field}`,
        ).toBeGreaterThan(20);
      }
      expect(["key", "plug", "warning"]).toContain(FAILURE_SURFACE[kind].icon);
    }
  });

  test("`outcome` is a BUCKET, not a discriminant, and the table says so", () => {
    // MEASURED: 401 and not-mounted both render `refused`. If this ever became
    // one-to-one it would still be fine — but a test that distinguished STATES on
    // `outcome` alone would confuse them, so the fact is pinned here.
    const refused = ALL_FAILURE_KINDS.filter(
      (kind) => FAILURE_SURFACE[kind].outcome === "refused",
    );
    expect(refused.length).toBeGreaterThan(1);
    expect(new Set(refused.map((k) => FAILURE_SURFACE[k].title)).size).toBe(
      refused.length,
    );
  });
});

describe("THE STAMP — a refused read says WHEN the page looked", () => {
  test("a failed read is stamped, from the error path", () => {
    const stamp = observationStamp({
      isPending: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 1_753_000_000_000,
    });
    expect(stamp.at).toBe(new Date(1_753_000_000_000).toISOString());
    expect(stamp.source).toBe("query");
  });

  test("a successful read is stamped from the success path", () => {
    const stamp = observationStamp({
      isPending: false,
      dataUpdatedAt: 1_753_000_050_000,
      errorUpdatedAt: 0,
    });
    expect(stamp.at).toBe(new Date(1_753_000_050_000).toISOString());
    expect(stamp.source).toBe("query");
  });

  test("MEASURED: when the query reports NO time, the page clock stamps it", () => {
    // React Query can report both timestamps as 0 for a failed read — measured
    // against the real page, where `data-read-at` came out empty. The page's own
    // clock is the fallback, and `source` says so rather than passing the two off
    // as the same kind of fact.
    const stamp = observationStamp({
      isPending: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      observedAt: 1_753_000_100_000,
    });
    expect(stamp.at).toBe(new Date(1_753_000_100_000).toISOString());
    expect(stamp.source).toBe("page-clock");
  });

  test("an unsettled read is not stamped, and never invents a time", () => {
    expect(
      observationStamp({
        isPending: true,
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
        observedAt: 1_753_000_100_000,
      }).at,
    ).toBeNull();
    const nothing = observationStamp({
      isPending: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
    });
    expect(nothing.at).toBeNull();
    expect(nothing.source).toBeNull();
  });

  test("CONTROL — two DIFFERENT looks produce two different stamps", () => {
    // The acceptance that matters: a constant stamp would pass a presence check
    // and prove nothing. The e2e test asserts this movement against the real page;
    // here the comparison itself is pinned so a broken predicate cannot pass.
    const differs = (a: string, b: string) => a !== b;
    const first = observationStamp({
      isPending: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 1_753_000_000_000,
    }).at as string;
    const second = observationStamp({
      isPending: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 1_753_000_001_000,
    }).at as string;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(differs(first, second)).toBe(true);
    // …and a hard-coded stamp FAILS that same predicate, which is what makes the
    // e2e assertion a real test rather than a presence check.
    expect(differs(first, first)).toBe(false);
  });
});
