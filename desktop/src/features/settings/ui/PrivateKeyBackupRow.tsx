import { Download, ShieldCheck } from "lucide-react";
import * as React from "react";

import {
  BACKUP_AVAILABILITY_MS,
  useEncryptedBackup,
} from "@/features/settings/EncryptedBackupProvider";
import {
  BackupTestFlow,
  initialBackupTestProgress,
} from "@/features/settings/ui/BackupTestFlow";
import { EncryptedBackupCreator } from "@/features/settings/ui/EncryptedBackupCreator";
import { copyNsecToClipboard } from "@/shared/api/tauriIdentity";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

function BackupAvailabilityFill({
  availableUntil,
}: {
  availableUntil: number;
}) {
  const [{ durationMs, initialWidth }] = React.useState(() => {
    const remainingMs = Math.max(0, availableUntil - Date.now());
    return {
      durationMs: remainingMs,
      initialWidth: Math.min(100, (remainingMs / BACKUP_AVAILABILITY_MS) * 100),
    };
  });
  const [width, setWidth] = React.useState(initialWidth);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setWidth(0));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 bg-primary-foreground/15 transition-[width] ease-linear"
      data-testid="encrypted-backup-availability-fill"
      style={{
        transitionDuration: `${durationMs}ms`,
        width: `${width}%`,
      }}
    />
  );
}

/**
 * Private-key row with backup actions. The key itself is NEVER held in React
 * state: "Copy key" calls `copy_nsec_to_clipboard`, which reads the key and
 * writes the clipboard entirely in Rust, so the renderer that shows remote
 * message content never holds the full nsec (key-lifecycle audit #5). The
 * encrypted-backup actions were already native (`create_ncryptsec_backup` /
 * `verify_ncryptsec_backup`).
 */
export function PrivateKeyBackupRow() {
  const [copyState, setCopyState] = React.useState<
    "idle" | "copying" | "copied"
  >("idle");
  const [copyError, setCopyError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [testOpen, setTestOpen] = React.useState(false);
  const [testProgress, setTestProgress] = React.useState(
    initialBackupTestProgress,
  );
  const {
    availableUntil,
    backupAvailable,
    downloadBackup,
    isSaving,
    startNewBackup,
  } = useEncryptedBackup();

  async function handleCopy() {
    setCopyState("copying");
    setCopyError(null);
    try {
      await copyNsecToClipboard();
      setCopyState("copied");
    } catch (err) {
      setCopyState("idle");
      setCopyError(
        err instanceof Error ? err.message : "Failed to copy private key.",
      );
    }
  }

  function handleCreateBackup() {
    if (backupAvailable) startNewBackup();
    setCreateOpen(true);
  }

  function handleTestOpenChange(open: boolean) {
    setTestOpen(open);
    if (!open) setTestProgress(initialBackupTestProgress);
  }

  return (
    <>
      <div className="px-4 py-3" data-testid="profile-private-key-row">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">Private key</p>
          <div className="flex shrink-0 items-center gap-2">
            {backupAvailable ? (
              <Button
                className="relative overflow-hidden rounded-full"
                data-testid="encrypted-backup-download"
                disabled={isSaving}
                onClick={() => void downloadBackup()}
                type="button"
              >
                {availableUntil !== null ? (
                  <BackupAvailabilityFill availableUntil={availableUntil} />
                ) : null}
                <span className="relative z-10">Download backup</span>
              </Button>
            ) : null}
            <Button
              aria-label="Copy private key"
              className="rounded-full"
              data-testid="profile-private-key-copy"
              disabled={copyState === "copying"}
              onClick={() => void handleCopy()}
              type="button"
              variant="secondary"
            >
              {copyState === "copying"
                ? "Copying…"
                : copyState === "copied"
                  ? "Copied"
                  : "Copy key"}
            </Button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            data-testid="private-key-create-backup"
            onClick={handleCreateBackup}
            type="button"
            variant="outline"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Create backup
          </Button>
          <Button
            data-testid="private-key-test-backup"
            onClick={() => setTestOpen(true)}
            type="button"
            variant="outline"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Test backup
          </Button>
        </div>
        {copyError ? (
          <p
            className="mt-2 text-sm text-destructive"
            data-testid="profile-private-key-copy-error"
          >
            {copyError}
          </p>
        ) : null}
      </div>
      <EncryptedBackupCreator onOpenChange={setCreateOpen} open={createOpen} />
      <Dialog onOpenChange={handleTestOpenChange} open={testOpen}>
        <DialogContent className="max-w-lg" data-testid="backup-test-dialog">
          <DialogHeader className="pr-8">
            <DialogTitle>Test a key backup</DialogTitle>
            <DialogDescription>
              Confirm that a backup file and its password can unlock an
              identity.
            </DialogDescription>
          </DialogHeader>
          <BackupTestFlow
            onProgressChange={setTestProgress}
            progress={testProgress}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Backups use the standard NIP-49 format, so this works for backups
            from compatible Nostr apps too.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
