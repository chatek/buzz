import { Lock } from "lucide-react";

import {
  CHANNEL_PRIVATE_REFUSAL_COPY,
  formatChannelReadError,
  isChannelPrivateRefusal,
} from "@/features/channels/lib/channelRefusal";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

/**
 * THE one renderer for channel read refusals — CHANNELS ALPHA §3 (D1), ruled
 * 2026-10-06. Every surface that can show a refused channel read (sidebar
 * error slot, channel-open timeline, route-open resolver) renders this
 * component instead of a raw relay/Rust error string.
 *
 * Variants:
 * - `private`: the §3 non-member-of-PRIVATE refusal. Title + the ruled copy,
 *   verbatim. No retry button: the fix is access, not a retry.
 * - `error`: any other read failure; body is the classified message (the
 *   refusal still renders the ruled copy via formatChannelReadError), retry
 *   optional.
 * - `sidebar`: compact banner for the sidebar's error slot.
 */
export function ChannelRefusalNotice({
  message,
  onRetry,
  variant = "private",
}: {
  /** The raw error message (or already-formatted text) to classify. */
  message?: string | null;
  onRetry?: () => void;
  variant?: "private" | "error" | "sidebar";
}) {
  const body =
    variant === "private"
      ? CHANNEL_PRIVATE_REFUSAL_COPY
      : formatChannelReadError(message ?? "");

  if (variant === "sidebar") {
    return (
      <div
        className="px-3 py-2 text-sm text-muted-foreground"
        data-testid="sidebar-channel-refusal-notice"
        role="status"
      >
        {body}
      </div>
    );
  }

  const isRefusal = variant === "private" || isChannelPrivateRefusal(message);

  return (
    <div
      className={cn(
        "mt-auto rounded-2xl border border-dashed px-6 py-10 text-center shadow-xs",
        isRefusal
          ? "border-border bg-muted/30"
          : "border-destructive/50 bg-destructive/5",
      )}
      data-testid={
        isRefusal ? "channel-refusal-notice" : "channel-read-error-notice"
      }
      role={isRefusal ? "status" : "alert"}
    >
      {isRefusal ? (
        <Lock
          aria-hidden="true"
          className="mx-auto h-5 w-5 text-muted-foreground"
        />
      ) : null}
      {isRefusal ? (
        /* §3 (D1): the ruled copy renders VERBATIM as one paragraph — no
           title that would duplicate or split the operator's sentence. */
        <p className="mt-3 text-base font-semibold tracking-tight">{body}</p>
      ) : (
        <>
          <p className="mt-3 text-base font-semibold tracking-tight">
            Couldn’t load messages
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        </>
      )}
      {!isRefusal && onRetry ? (
        <Button
          className="mt-4"
          data-testid="channel-read-error-retry"
          onClick={onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
