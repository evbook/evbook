import type { ReactNode } from "react";
import { BrandMark } from "@/components/Shell";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The frame for the screens before the shell — sign in, connect a Tesla
 * account, first-run setup. One card, centred, under the mark: the same three
 * moments should look like three pages of one thing, and the mark is what says
 * whose page this is before any of them has said anything else.
 *
 * The mark sits in a soft glow of its own colour, the one flourish these
 * screens allow themselves: it is the first thing anyone sees of the app.
 */
export function AuthFrame({
  title,
  description,
  width = "sm",
  children,
}: {
  title: string;
  description?: ReactNode;
  width?: "sm" | "lg";
  children: ReactNode;
}) {
  return (
    <div className="evb-page flex min-h-screen items-center justify-center p-4">
      <div className={cn("w-full", width === "sm" ? "max-w-sm" : "max-w-lg")}>
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          <div className="relative isolate">
            <div
              aria-hidden="true"
              className="evb-gradient-brand absolute inset-0 -z-10 scale-150 rounded-full opacity-30 blur-2xl"
            />
            <BrandMark className="size-12 rounded-2xl shadow-raised" />
          </div>
          <div className="space-y-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
            {description && <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{description}</p>}
          </div>
        </div>
        <Card className="shadow-raised">
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}
