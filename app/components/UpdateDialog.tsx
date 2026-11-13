import type { ReactNode } from "react";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import type { InstancePlatform } from "@shared/api-types";
import { RELEASE_REPO } from "@shared/version";
import type { UpdateFlow } from "@/hooks/useUpdateFlow";
import { ONE_CLICK_UPDATES_DOCS } from "@/lib/updateNotice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CopyField } from "@/components/CopyField";

/**
 * What "Update" opens. One button, two things it can mean:
 *
 *  - an instance that can install for itself (a GitHub token is configured)
 *    asks once, then starts the deploy and follows it;
 *  - any other is walked through updating by hand — the steps for whatever it
 *    runs on, each command one click to copy — while the page watches for the
 *    new build and says so when it is live.
 *
 * Either way the instance is replaced from outside itself, by GitHub Actions or
 * by its owner's terminal: a process that redeploys itself and fails half-way
 * has broken the only thing able to fix it.
 */
export function UpdateDialog({ flow, open, onClose }: { flow: UpdateFlow; open: boolean; onClose: () => void }) {
  const { info, phase } = flow;
  if (!info) return null;
  const latest = info.latest ?? "";

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      {phase === "landed" ? (
        <>
          <Title>
            <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            EVBook {info.current} is live
          </Title>
          <Body>The new version is running. Reload to switch this page over to it.</Body>
          <Actions>
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </Actions>
        </>
      ) : phase === "failed" ? (
        <>
          <Title>The update did not go through</Title>
          <Body>
            The deploy finished with “{flow.run?.conclusion ?? "no conclusion"}”, and this instance is untouched — it is
            still running {info.current}.{" "}
            {flow.run && <ExternalLink href={flow.run.url}>Read the run on GitHub</ExternalLink>}
          </Body>
          <Actions>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={flow.reset}>
              Try again
            </Button>
          </Actions>
        </>
      ) : phase === "deploying" ? (
        <>
          <Title>
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
            Updating to {latest}…
          </Title>
          <Body>
            GitHub is building {latest} and will replace this instance with it, which takes a couple of minutes.
            Everything keeps running meanwhile. You can close this; it carries on without you.{" "}
            {flow.run && <ExternalLink href={flow.run.url}>Follow along on GitHub</ExternalLink>}
          </Body>
          <Actions>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </Actions>
        </>
      ) : info.canInstall ? (
        <>
          <Title>Update to {latest}?</Title>
          <Body>
            EVBook starts its deploy workflow on GitHub, which builds {latest} and replaces this instance with it. That
            takes a couple of minutes; logging carries on throughout, and your history is never touched.{" "}
            {info.releaseUrl && <ExternalLink href={info.releaseUrl}>What’s new in {latest}</ExternalLink>}
          </Body>
          {flow.startError && <p className="mt-3 text-sm text-destructive">{flow.startError}</p>}
          <Actions>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Not now
            </Button>
            <Button size="sm" disabled={flow.starting} onClick={flow.start}>
              {flow.starting ? "Starting…" : "Update now"}
            </Button>
          </Actions>
        </>
      ) : (
        <>
          <Title>Update to {latest}</Title>
          <Body>
            {info.platform === "cloudflare"
              ? "A Worker is updated the way it was first deployed: from a computer, in a couple of minutes."
              : "A server is updated by fetching the new image and restarting on it."}{" "}
            Logging carries on throughout, migrations apply themselves, and your history is never touched.{" "}
            {info.releaseUrl && <ExternalLink href={info.releaseUrl}>What’s new in {latest}</ExternalLink>}
          </Body>
          <ol className="mt-4 space-y-4">
            {STEPS[info.platform].map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-sm">{step.title}</p>
                  {step.command && <CopyField value={step.command} label={`Copy “${step.command}”`} />}
                  {step.fallback && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">{step.fallback.summary}</summary>
                      <p className="mt-1.5">{step.fallback.text}</p>
                      <CopyField
                        className="mt-1.5"
                        value={step.fallback.command}
                        label={`Copy “${step.fallback.command}”`}
                      />
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p role="status" className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            Waiting for {latest} to go live. This page notices by itself.
          </p>
          {info.platform === "cloudflare" && (
            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
              Rather have this be one click? EVBook can install its own updates through GitHub Actions, after a one-time
              setup. <ExternalLink href={ONE_CLICK_UPDATES_DOCS}>How to set it up</ExternalLink>
            </p>
          )}
          <Actions>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </Actions>
        </>
      )}
    </Dialog>
  );
}

interface Step {
  title: string;
  command?: string;
  /** For the reader who cannot do the step as written. */
  fallback?: { summary: string; text: string; command: string };
}

/** Updating by hand, per platform. docs/updating.md says the same in prose. */
const STEPS: Record<InstancePlatform, Step[]> = {
  cloudflare: [
    {
      title: "Open a terminal in the folder you deployed EVBook from.",
      fallback: {
        summary: "No longer have that folder?",
        text: "A fresh copy does just as well. Deploying from it updates the same Worker, as long as the Cloudflare CLI is signed in to the same account.",
        command: `git clone https://github.com/${RELEASE_REPO} && cd evbook`,
      },
    },
    { title: "Fetch the new version.", command: "git pull" },
    { title: "Build and deploy it.", command: "bun install && bun run deploy" },
  ],
  node: [
    { title: "On the server, open the folder that holds docker-compose.yml." },
    { title: "Fetch the new image.", command: "docker compose pull" },
    { title: "Restart on it.", command: "docker compose up -d" },
  ],
};

function Title({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-sm font-medium">{children}</p>;
}

function Body({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="whitespace-nowrap underline underline-offset-2">
      {children}
    </a>
  );
}
