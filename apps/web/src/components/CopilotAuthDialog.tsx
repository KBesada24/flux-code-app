import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";

interface CopilotAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CopilotAuthDialog({ open, onOpenChange }: CopilotAuthDialogProps) {
  const queryClient = useQueryClient();
  const [authStart, setAuthStart] = useState<{
    authId: string;
    verificationUri: string;
    userCode: string;
    expiresAt: string;
    intervalSeconds: number;
  } | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAuthStart(null);
      setAuthStatus(null);
      setAuthError(null);
      return;
    }
    let cancelled = false;
    ensureNativeApi()
      .providers.copilotAuth.start({})
      .then((start) => {
        if (cancelled) return;
        setAuthStart(start);
        void ensureNativeApi().shell.openExternal(start.verificationUri);
      })
      .catch((err) => {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : "Failed to start Copilot login.");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!authStart) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await ensureNativeApi().providers.copilotAuth.poll({
          authId: authStart.authId,
        });
        if (cancelled) return;
        setAuthStatus(result.status);
        if (result.status === "authorized") {
          await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
          onOpenChange(false);
          return;
        }
        if (result.status === "pending") {
          window.setTimeout(poll, Math.max(1, authStart.intervalSeconds) * 1000);
          return;
        }
        setAuthError(result.message ?? "Copilot login failed.");
      } catch (err) {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : "Copilot login failed.");
      }
    };
    window.setTimeout(poll, Math.max(1, authStart.intervalSeconds) * 1000);
    return () => {
      cancelled = true;
    };
  }, [authStart, queryClient, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect GitHub Copilot</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3 text-sm">
            {authError ? (
              <p className="text-xs text-destructive">{authError}</p>
            ) : authStart ? (
              <>
                <p>Open the GitHub device login page and enter this code:</p>
                <div className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-base tracking-widest">
                  {authStart.userCode}
                </div>
                <p className="text-xs text-muted-foreground">{authStart.verificationUri}</p>
                {authStatus && authStatus !== "pending" && (
                  <p className="text-xs text-muted-foreground capitalize">
                    Status: {authStatus}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">Starting device login…</p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              authStart && void ensureNativeApi().shell.openExternal(authStart.verificationUri)
            }
            disabled={!authStart}
          >
            Open verification page
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
