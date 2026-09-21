/**
 * Small presentational pieces shared by the console panels. Keeping them here
 * means the panels read as what they say, and it keeps every file inside the
 * repo's 1000-line per-file policy.
 *
 * Two rules are enforced by these components rather than by discipline:
 *
 *  - `NumberCard` REQUIRES its own label and its own footnote, so no number can
 *    be rendered without saying what it counts.
 *  - `Absent` is the only way this feature renders "no value". It prints words,
 *    never a dash, a zero, or a masked placeholder: an absent field and a zero
 *    are different facts, and a placeholder that looks like a value is a lie
 *    about data the payload does not contain.
 */

import type * as React from "react";

import { cn } from "@/shared/lib/cn";

export function Chip({
  children,
  tone = "border-black/10 bg-black/5 text-black/70 dark:border-white/15 dark:bg-white/10 dark:text-white/70",
  className,
  testId,
}: {
  children: React.ReactNode;
  tone?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A named number. The label and the note are required, and so is ONE OF `value` or
 * `absentReason` — they are a discriminated union, so a call site cannot render a
 * number without asking for a number, and cannot render a count for a field the
 * payload did not carry.
 *
 * WHY THE UNION, AND NOT A SEPARATE COMPONENT. Lane 2 found twenty call sites
 * passing `totals.x ?? 0`, which renders `0` for a field the service never sent —
 * and one site substituting a DIFFERENT quantity under the same label
 * (`totals.in_scope ?? populations.inconsistent`). A type that accepts
 * `number | string` invites `?? 0`; a union that forces `value` or `absentReason`
 * makes the author decide, and the accompanying structural check
 * (`tests/unit/console-honesty-structure.test.ts`) bans the `?? 0` shape outright.
 *
 * `data-value` says which branch rendered, so a test can assert the absence branch
 * without matching prose: an absence is a fact about the payload's shape, and
 * matching words would break the moment the wording improved.
 */
export function NumberCard(
  props: {
    label: string;
    /** What this number counts. Required: a bare number is not a report. */
    note: string;
    tone?: string;
    testId?: string;
  } & (
    | { value: number | string; absentReason?: undefined }
    | { absentReason: string; value?: undefined }
  ),
) {
  const { label, note, tone = "border-border/70", testId } = props;
  const absent = props.absentReason !== undefined;
  return (
    <div
      className={cn("rounded-lg border bg-card/60 px-3 py-2", tone)}
      data-number-card=""
      data-scan-unit=""
      data-testid={testId}
      data-value={absent ? "absent" : "present"}
    >
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">
        {absent ? (
          <span className="text-sm font-normal">
            <Absent reason={props.absentReason as string} />
          </span>
        ) : (
          props.value
        )}
      </div>
      <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
        {note}
      </div>
    </div>
  );
}

/**
 * A count that the payload MAY not have carried. The `absentReason` is REQUIRED, so
 * a call site cannot pass `undefined` silently: it must say what an operator should
 * understand when the field is missing. `value: undefined` is the only accepted way
 * to express absence — `totals.x ?? 0` is banned by the structural check, because a
 * zero is a fact about data, and a missing field is a fact about the payload.
 */
export function CountCard({
  label,
  value,
  absentReason,
  note,
  tone,
  testId,
}: {
  label: string;
  value: number | undefined;
  absentReason: string;
  note: string;
  tone?: string;
  testId?: string;
}) {
  if (value === undefined) {
    return (
      <NumberCard
        absentReason={absentReason}
        label={label}
        note={note}
        testId={testId}
        tone={tone}
      />
    );
  }
  return (
    <NumberCard
      label={label}
      note={note}
      testId={testId}
      tone={tone}
      value={value}
    />
  );
}

/** label / value row. */
export function Kv({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-xs">
      <span className="min-w-40 text-muted-foreground">{label}</span>
      <span className={cn("break-all", mono && "font-mono text-[11px]")}>
        {children}
      </span>
    </div>
  );
}

/**
 * The ONLY way this feature says "there is no value here". It takes the reason
 * as a parameter, because "not recorded" and "not in the projection" and "not
 * built" are three different facts.
 */
export function Absent({ reason }: { reason: string }) {
  return (
    <span className="italic text-muted-foreground" data-testid="idp-absent">
      {reason}
    </span>
  );
}

/** A one-line note under a heading. */
export function SectionNote({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <p
      className={cn("text-xs leading-5 text-muted-foreground", className)}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

/** Shown when a staged capture is answering instead of the gateway. */
export function StagedChip() {
  return (
    <Chip
      className="uppercase"
      tone="border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-200"
      testId="staged-chip"
    >
      staged data
    </Chip>
  );
}

export function Monospace({ children }: { children: React.ReactNode }) {
  return (
    <code className="break-all rounded bg-black/5 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">
      {children}
    </code>
  );
}
