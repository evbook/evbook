import { AuthFrame } from "@/components/AuthFrame";

export function SetupPage() {
  return (
    <AuthFrame
      width="lg"
      title="Almost there"
      description="Two secrets need to be configured before EVBook can start."
    >
      <div className="space-y-3 text-sm">
        <p>Run these in the project directory, then reload this page:</p>
        <pre className="rounded-lg border bg-muted/60 p-4 text-xs leading-6">
          {"npx wrangler secret put APP_PASSWORD\nnpx wrangler secret put ENCRYPTION_KEY"}
        </pre>
        <p className="leading-relaxed text-muted-foreground">
          <code>APP_PASSWORD</code> is what you will log in with. <code>ENCRYPTION_KEY</code> encrypts your Tesla tokens
          at rest — use a long random string and keep it safe.
        </p>
      </div>
    </AuthFrame>
  );
}
