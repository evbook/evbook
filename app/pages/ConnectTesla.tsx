import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiRequestError } from "@/lib/api";
import { AuthFrame } from "@/components/AuthFrame";
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

export function ConnectTeslaPage() {
  const queryClient = useQueryClient();
  const [access, setAccess] = useState("");
  const [refresh, setRefresh] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/tesla", { method: "POST", body: JSON.stringify({ access, refresh }) });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(err instanceof ApiRequestError && err.message ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      width="lg"
      title="Connect your Tesla account"
      description={
        <>
          Paste the tokens from a token app you trust (e.g. "Auth app for Tesla" on iOS or "Tesla Tokens" on Android).
          Tokens are validated immediately and stored encrypted.
        </>
      }
    >
      <div className="mb-5 rounded-lg bg-muted/60 p-3 text-sm">
        <p className="font-medium">On a computer? Use EVBook Token Helper</p>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-muted-foreground">
          <li>
            <a
              href={EXTENSION_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Add it to Chrome
            </a>
            .
          </li>
          <li>Click its icon, then Sign in with Tesla.</li>
          <li>Copy both tokens into the fields below.</li>
        </ol>
      </div>
      <form onSubmit={submit} className="space-y-4">
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
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !access || !refresh}>
          {busy ? "Validating…" : "Sign in to Tesla"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Coming from another logger?{" "}
        <Link to="/import" className="font-medium text-foreground underline underline-offset-4">
          Import your history
        </Link>{" "}
        first — no Tesla account needed.
      </p>
    </AuthFrame>
  );
}
