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

/** A named number. The label and the note are required. */
export function NumberCard({
  label,
  value,
  note,
  tone = "border-border/70",
  testId,
}: {
  label: string;
  value: number | string;
  note: string;
  tone?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("rounded-lg border bg-card/60 px-3 py-2", tone)}
      data-testid={testId}
    >
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
        {note}
      </div>
    </div>
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
