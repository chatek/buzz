import { Button } from "@/shared/ui/button";
import { formatChannelReadError } from "@/features/channels/lib/channelRefusal";

/**
 * Retryable terminal failure for a channel history load with no cached rows.
 *
 * §3 (D1): when `message` carries the private-channel wire refusal, the body
 * renders the ruled copy instead of the raw relay/Rust error string (see
 * `formatChannelReadError`); every other error class keeps its message.
 */
export function MessageTimelineErrorCard({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  const body = message ? formatChannelReadError(message) : null;
  return (
    <div
      className="mt-auto rounded-2xl border border-dashed border-destructive/50 bg-destructive/5 px-6 py-10 text-center shadow-xs"
      data-testid="message-timeline-error"
      role="alert"
    >
      <p className="text-base font-semibold tracking-tight">
        Couldn&apos;t load messages
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {body ??
          "The channel history didn’t load. Check your connection and try again."}
      </p>
      {onRetry ? (
        <Button
          className="mt-4"
          data-testid="message-timeline-retry"
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
