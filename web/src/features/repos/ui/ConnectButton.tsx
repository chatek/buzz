import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  detectBuzzDownloadPlatform,
  resolveBuzzDownloadUrlForPlatform,
} from "@/shared/lib/buzz-download";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

/**
 * "Open in Buzz", for a browser that cannot open a `buzz://` link.
 *
 * THE FAILURE THIS EXISTS TO END (MEASURED 2026-09-21 on macOS with no handler
 * registered — `lsregister -dump | grep -c 'buzz:'` = 0, no `Buzz.app`): clicking
 * this control produced NO navigation, NO console message, NO page error and NO
 * dialog. The URL was byte-identical before and after, and nothing was rendered to
 * explain it: one request to `buzz://connect?relay=…` that the OS discarded. A
 * silent no-op is the worst failure shape, so the button now always says what to do
 * when nothing happens.
 *
 * WHY THIS IS NOT A DETECTOR. A page cannot ask the OS whether a custom scheme is
 * registered: Chromium and Firefox expose nothing, and Safari's `buzz:` probe is a
 * gesture-blocked navigation that reports nothing either. So the component offers
 * the link and then reveals instructions after `FALLBACK_DELAY_MS`, unconditionally.
 * That is truthful in both outcomes — if Buzz opened, nobody is looking at this page
 * any more; if it did not, the panel explains the two things the user can actually do.
 *
 * THE COPY STAYS HONEST ABOUT TODAY. Upstream Buzz (`BUZZ_RELEASES_URL`) does not
 * carry the vclaw sign-in yet, and this tree's desktop crate is not bundled, so the
 * download link is labelled as upstream-only and the PRIMARY action offered is the
 * deep link itself, which works with any client that already holds the user's key.
 */
const FALLBACK_DELAY_MS = 1200;

export function ConnectButton({ className }: { className?: string }) {
  const deepLink = `buzz://connect?relay=${encodeURIComponent(relayWsUrl())}`;
  const [showInstructions, setShowInstructions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // Start the explain-anyway timer on click. The anchor still carries the real
  // href, so a machine WITH a handler opens Buzz and never sees this.
  const handleClick = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(
      () => setShowInstructions(true),
      FALLBACK_DELAY_MS,
    );
  }, []);

  // Resolve the (honestly labelled) upstream download link only once it is needed.
  useEffect(() => {
    if (!showInstructions || downloadUrl) return;
    let active = true;
    void (async () => {
      const platform = await detectBuzzDownloadPlatform(navigator);
      const url = await resolveBuzzDownloadUrlForPlatform(platform);
      if (active) setDownloadUrl(url);
    })();
    return () => {
      active = false;
    };
  }, [showInstructions, downloadUrl]);

  const copyDeepLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
    } catch {
      // Clipboard can be refused (insecure context, permissions). The link is
      // rendered as selectable text either way, so this is not a dead end.
      setCopied(false);
    }
  }, [deepLink]);

  return (
    <div className={className}>
      <Button
        asChild
        className="bg-black text-white hover:bg-black/90 focus-visible:ring-black dark:bg-white dark:text-black dark:hover:bg-white/90 dark:focus-visible:ring-white"
      >
        <a href={deepLink} onClick={handleClick}>
          <ExternalLink className="h-4 w-4" />
          Open in Buzz
        </a>
      </Button>

      {showInstructions && (
        <div
          aria-live="polite"
          data-testid="buzz-open-fallback"
          className="mt-2 max-w-xl rounded-md border border-amber-300 bg-amber-50 p-3 text-left text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">
            Nothing happened? Buzz is probably not installed.
          </p>
          <p className="mt-1">
            If no Buzz window opened, this computer has no app registered for
            <code className="mx-1 rounded bg-black/10 px-1 py-0.5">
              buzz://
            </code>
            links. You can still continue:
          </p>
          <ol className="mt-2 list-decimal space-y-2 pl-4">
            <li>
              <span className="font-medium">
                Copy the link and open it in a Buzz client
              </span>{" "}
              that holds your key:
              <div className="mt-1 flex items-center gap-2">
                <input
                  readOnly
                  aria-label="Buzz deep link"
                  data-testid="buzz-deep-link"
                  value={deepLink}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full rounded border border-amber-400 bg-white px-2 py-1 font-mono text-[11px] text-black dark:bg-black dark:text-white"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyDeepLink()}
                  data-testid="buzz-copy-link"
                >
                  {copied ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </li>
            <li>
              <span className="font-medium">
                Read, push and review in the browser instead
              </span>{" "}
              — the dashboard works without the desktop app.
            </li>
            <li>
              Upstream Buzz desktop is at{" "}
              <a
                href={downloadUrl ?? "https://github.com/block/buzz/releases"}
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                github.com/block/buzz/releases
              </a>
              , but{" "}
              <span className="font-medium">it has no vclaw sign-in yet</span>,
              so it will not connect to this relay.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
