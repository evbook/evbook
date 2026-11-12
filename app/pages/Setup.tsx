import type { SetupInfo } from "@shared/api-types";
import { makeNames } from "@/lib/makes";
import { AuthFrame } from "@/components/AuthFrame";
import { CopyField } from "@/components/CopyField";

const SECRETS: Record<SetupInfo["missing"][number], string> = {
  APP_PASSWORD: "what you will log in with",
  ENCRYPTION_KEY: "encrypts your car accounts' sign-ins at rest",
};

/**
 * The instance is running and cannot be used yet: a secret is missing. This
 * screen says which, and gives the instruction for where this EVBook actually
 * runs — the server tells it (`setup`), so a Cloudflare owner is not reading
 * about `.env` and a Docker owner about `bun run setup`.
 *
 * It does not ask to be reloaded. The session is asked again every few seconds
 * while this screen is up (see `useSession`), so it gives way to the password
 * screen by itself the moment the secrets are there.
 */
export function SetupPage({ setup }: { setup?: SetupInfo }) {
  const missing = setup?.missing ?? (["APP_PASSWORD", "ENCRYPTION_KEY"] as const);
  const runtime = setup?.runtime;
  const one = missing.length === 1;

  return (
    <AuthFrame
      width="lg"
      title="Almost there"
      description={`EVBook is running, but ${one ? "one secret is" : "two secrets are"} not set yet.`}
    >
      <div className="space-y-5 text-sm">
        <ul className="space-y-1.5">
          {missing.map((name) => (
            <li key={name}>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{name}</code>{" "}
              <span className="text-muted-foreground">— {SECRETS[name]}</span>
            </li>
          ))}
        </ul>

        {runtime !== "server" && (
          <div className="space-y-2">
            <p>
              {runtime ? "Run this in the project directory:" : "On Cloudflare, run this in the project directory:"}
            </p>
            <CopyField value="bun run setup" label="Copy the command" />
            <p className="leading-relaxed text-muted-foreground">
              It asks for the password, generates the key, and deploys. A key that already exists is never replaced.
            </p>
          </div>
        )}
        {runtime !== "cloudflare" && (
          <div className="space-y-2">
            <p>
              {runtime ? "Set" : "On your own server, set"} {one ? "it" : "both"} in <code>.env</code>.
              {missing.includes("ENCRYPTION_KEY") && " Any long random string works as the key; this makes one:"}
            </p>
            {missing.includes("ENCRYPTION_KEY") && (
              <CopyField value="openssl rand -base64 32" label="Copy the command" />
            )}
            <p>Then restart:</p>
            <CopyField value="docker compose up -d" label="Copy the command" />
            {missing.includes("ENCRYPTION_KEY") && (
              <p className="leading-relaxed text-muted-foreground">
                Keep the key safe: losing it means signing in to your car accounts again. Your logged history is never
                affected.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2.5 border-t pt-4 text-muted-foreground">
          <span className="evb-spinner size-4 shrink-0" aria-hidden="true" />
          <p>
            Waiting for {one ? "it" : "them"} — this page moves on by itself. Then you log in and connect your car (
            {makeNames()}).
          </p>
        </div>
      </div>
    </AuthFrame>
  );
}
