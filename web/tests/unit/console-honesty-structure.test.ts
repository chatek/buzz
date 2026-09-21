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
 * rendered fact — lane 2's allow-list, kept verbatim with its reason.
 */
const ALLOWED: Record<string, string> = {
  "idp-fixture-builders.ts:78":
    "sums per-state row counts inside a staged fixture; a missing key means zero rows",
};

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
      .filter((hit) => !(`${hit.file}:${hit.line}` in ALLOWED));
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
    for (const [site, reason] of Object.entries(ALLOWED)) {
      expect(site, "an allow-list key must be file:line").toMatch(
        /^[\w.-]+:\d+$/,
      );
      expect(reason.length, `${site} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
