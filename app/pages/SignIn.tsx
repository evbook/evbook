import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiRequestError } from "@/lib/api";
import { AuthFrame } from "@/components/AuthFrame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInPage() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(signInError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="EVBook" description="Enter the app password to continue.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthFrame>
  );
}

function signInError(err: unknown): string {
  if (!(err instanceof ApiRequestError)) return "Sign-in failed. Try again.";
  if (err.status === 401) return "Wrong password.";
  if (err.status === 429) {
    const wait = err.retryAfter === undefined ? "a while" : waitFor(err.retryAfter);
    return `Too many wrong passwords. Try again in ${wait}.`;
  }
  return "Sign-in failed. Try again.";
}

/** "40 seconds", "2 minutes": rounded up, so trying again at the time given works. */
function waitFor(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
