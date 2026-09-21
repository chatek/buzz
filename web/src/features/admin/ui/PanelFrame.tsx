/**
 * One frame for every panel: the heading, the exact endpoint being read, the
 * staged/live marker, and — the important part — the three legitimate states:
 * still reading, refused, or answered.
 *
 * "Still reading" is bounded. The read has a deadline in `idp-source.ts`, and
 * this frame additionally says out loud that it is still waiting after
 * `IDP_SLOW_READ_MS`, so no operator can be left looking at a spinner that will
 * never resolve and no reviewer can mistake patience for data.
 */

import * as React from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import { IDP_SLOW_READ_MS, type IdpSource, toIdpFailure } from "../idp-source";
import { IdpClosedNotice } from "./IdpClosedNotice";
import { Monospace, SectionNote, StagedChip } from "./idp-bits";

export function PanelFrame<T>({
  title,
  description,
  path,
  source,
  query,
  emptyNote,
  isEmpty,
  children,
}: {
  title: string;
  description: string;
  /** The endpoint, printed so the same read can be repeated by hand. */
  path: string;
  source: IdpSource;
  query: UseQueryResult<T, unknown>;
  /** What an empty answer means, when an empty answer is possible for this read. */
  emptyNote?: string;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  const [slow, setSlow] = React.useState(false);
  const pending = query.isPending;

  React.useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), IDP_SLOW_READ_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const state = query.isError ? "closed" : pending ? "loading" : "ready";
  const empty =
    !query.isError &&
    !pending &&
    query.data !== undefined &&
    isEmpty?.(query.data) === true;

  return (
    <section
      aria-label={title}
      className="rounded-xl border border-border/70 bg-card/40"
      data-testid="idp-panel"
      data-panel={path}
      data-state={state}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            {source.kind === "staged" ? <StagedChip /> : null}
          </h2>
          <SectionNote className="mt-0.5">{description}</SectionNote>
          <div className="mt-1 text-[11px] text-muted-foreground">
            reads <Monospace>{path}</Monospace>
          </div>
        </div>
        <Button
          disabled={pending}
          onClick={() => void query.refetch()}
          size="sm"
          variant="ghost"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {pending ? "Reading…" : "Re-read"}
        </Button>
      </header>
      <div className="px-4 py-3">
        {query.isError ? (
          <IdpClosedNotice
            failure={toIdpFailure(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : pending ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="idp-panel-loading"
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            <span>Reading {path}…</span>
            {slow ? (
              <span
                className="text-amber-700 dark:text-amber-300"
                data-testid="idp-panel-still-waiting"
              >
                still waiting after {Math.round(IDP_SLOW_READ_MS / 1000)} s —
                the read fails rather than waiting forever
              </span>
            ) : null}
          </div>
        ) : query.data === undefined ? (
          <IdpClosedNotice
            failure={{
              kind: "unexpected",
              status: null,
              path,
              title: "Unexpected reply",
              meaning:
                "The read settled without a payload and without an error. That combination is a defect in this console, not a state of the gateway.",
              evidence: "no data and no error",
            }}
          />
        ) : (
          <div className="space-y-4">
            {empty && emptyNote ? (
              <p
                className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground"
                data-testid="idp-empty-note"
              >
                {emptyNote}
              </p>
            ) : null}
            {children(query.data)}
          </div>
        )}
      </div>
    </section>
  );
}
