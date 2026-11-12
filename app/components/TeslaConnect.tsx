import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AccountDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";
import { accountTitle } from "@/lib/makes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The Token Helper extension, maintained outside this repository. Tesla's sign-in for
 * the Owner API only redirects to the mobile app's `tesla://` scheme, so a web
 * page cannot catch it — the extension can, and swaps the code for tokens in the
 * browser. Published on the Chrome Web Store (works in Edge and Brave too).
 */
const EXTENSION_URL = "https://chromewebstore.google.com/detail/evbook-token-helper/bmlcajjacefiijccjjliojdaekghclld";

/**
 * Connecting a Tesla account: where a token pair comes from, and the two fields
 * it goes in. One form for all three occasions — the first account, another
 * one beside it, and signing a lapsed one back in (`account`) — because the
 * owner does the same thing each time and the server works out which it was.
 */
export function TeslaConnect({ account, onDone }: { account?: string | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountDto[]>("/api/v1/accounts") });
  const [access, setAccess] = useState("");
  const [refresh, setRefresh] = useState("");
  const [label, setLabel] = useState("");

  const tesla = (accounts.data ?? []).filter((a) => a.provider === "tesla");
  const returning = account ? tesla.find((a) => a.name === account) : undefined;
  // A name only earns its field once there is a second account to tell apart.
  const another = !account && tesla.some((a) => a.signedIn);

  const connect = useMutation({
    mutationFn: () =>
      api("/api/v1/accounts/tesla", {
        method: "POST",
        body: JSON.stringify({ access, refresh, ...(another && { label }), ...(account && { account }) }),
      }),
    onSuccess: async () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["cars"] });
      // Awaited: on a first run the session is what swaps this screen for the app.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      onDone();
    },
  });

  return (
    <div className="space-y-5 text-sm">
      {returning && (
        <p className="rounded-md bg-muted/60 px-3 py-2">
          Signing <span className="font-medium">{accountTitle(returning)}</span> back in. Its cars and their history
          stay as they are.
        </p>
      )}
      {another && (
        <p className="rounded-md bg-muted/60 px-3 py-2">
          A Tesla account is already connected, so this adds another beside it. Its cars are logged like the first
          account&apos;s.
        </p>
      )}

      <div className="rounded-lg bg-muted/60 p-3">
        <p className="font-medium">Where the tokens come from</p>
        <dl className="mt-1.5 space-y-1.5 text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">On a computer: </dt>
            <dd className="inline">
              add{" "}
              <a
                href={EXTENSION_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-4"
              >
                EVBook Token Helper
              </a>{" "}
              to Chrome, click its icon, then Sign in with Tesla.
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">On a phone: </dt>
            <dd className="inline">
              a token app you trust — &ldquo;Auth app for Tesla&rdquo; on iOS, &ldquo;Tesla Tokens&rdquo; on Android.
            </dd>
          </div>
        </dl>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
      >
        {another && (
          <div className="space-y-2">
            <Label htmlFor="tesla-label">Name (optional)</Label>
            <Input id="tesla-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Work" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="access">Access token</Label>
          <Input
            id="access"
            type="password"
            value={access}
            onChange={(e) => setAccess(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="refresh">Refresh token</Label>
          <Input
            id="refresh"
            type="password"
            value={refresh}
            onChange={(e) => setRefresh(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {connect.isError && (
          <p className="text-destructive">
            {connect.error instanceof ApiRequestError && connect.error.message
              ? connect.error.message
              : "Sign-in failed."}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={connect.isPending || !access || !refresh}>
          {connect.isPending ? "Validating…" : "Sign in to Tesla"}
        </Button>
      </form>
    </div>
  );
}
