import { AuthFrame } from "@/components/AuthFrame";

export function SetupPage() {
  return (
    <AuthFrame
      width="lg"
      title="Almost there"
      description="Two secrets need to be configured before EVBook can start."
    >
      <div className="space-y-3 text-sm">
        <p>On Cloudflare, run this in the project directory, then reload this page:</p>
        <pre className="rounded-lg border bg-muted/60 p-4 text-xs leading-6">{"npm run setup"}</pre>
        <p className="leading-relaxed text-muted-foreground">
          It asks for <code>APP_PASSWORD</code> — what you will log in with — and generates <code>ENCRYPTION_KEY</code>,
          which encrypts your Tesla tokens at rest. On your own server, set both in <code>.env</code> and restart.
        </p>
      </div>
    </AuthFrame>
  );
}
