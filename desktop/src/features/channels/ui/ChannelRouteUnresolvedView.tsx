import { useQuery } from "@tanstack/react-query";

import { ChannelRefusalNotice } from "@/features/channels/ui/ChannelRefusalNotice";
import { isChannelPrivateRefusal } from "@/features/channels/lib/channelRefusal";
import { getChannelMembers } from "@/shared/api/tauri";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

/**
 * §3 (D1), ruled 2026-10-06: what the user SEES when a routed channel id
 * resolves to NOTHING in the member list or the open-channel directory.
 *
 * The wire distinguishes the two absent cases and so does this view, with one
 * directed read (the roster probe, `{"kinds":[39002],"#d":[id]}`):
 *
 *   - non-member of a PRIVATE channel → the relay refuses (403, the §3 wire
 *     refusal) → the ruled refusal copy, rendered by the ONE refusal renderer.
 *   - UNKNOWN channel id → 200 with no roster authored (deliberately NOT a
 *     refusal — a refusal would assert a membership fact the registry does not
 *     have) → the client's own "channel members not found" error → rendered
 *     as does-not-exist, upstream parity.
 *
 * Any other probe failure (connectivity, auth) renders as a read error with a
 * retry, never as "doesn't exist".
 */
export function ChannelRouteUnresolvedView({
  channelId,
}: {
  channelId: string;
}) {
  const probeQuery = useQuery({
    queryKey: ["channel-route-resolve", channelId],
    queryFn: () => getChannelMembers(channelId),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (probeQuery.isPending) {
    return <ViewLoadingFallback includeHeader kind="channel" />;
  }

  const probeMessage =
    probeQuery.error instanceof Error ? probeQuery.error.message : null;

  if (isChannelPrivateRefusal(probeMessage)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <ChannelRefusalNotice variant="private" />
      </div>
    );
  }

  // 200 with no roster authored = the registry holds no such channel.
  // A probe SUCCESS landing here means a visibility race (the channel became
  // readable between the directory read and this probe); the not-found view is
  // the honest stop until the channels poll re-lists it.
  const isUnknownChannelId =
    probeQuery.isSuccess ||
    (probeMessage?.includes("channel members not found") ?? false);

  if (!isUnknownChannelId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <ChannelRefusalNotice
          message={probeMessage ?? undefined}
          onRetry={() => {
            void probeQuery.refetch();
          }}
          variant="error"
        />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6"
      data-testid="channel-not-found"
    >
      <p className="text-sm text-muted-foreground">
        This channel doesn’t exist.
      </p>
    </div>
  );
}
