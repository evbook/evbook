import * as React from "react";
import { cn } from "@/lib/utils";

/*
  A card is white on an off-white page, with a hairline border and a shadow that
  is mostly a contact line. The lift comes from tone, not from the shadow — see
  the palette notes in index.css.

  `min-w-0` because a card is usually a grid or flex item, and those default to
  being no narrower than their content: a wide table inside would widen its
  column, and on a phone the whole page, instead of scrolling in its own box.
*/
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("min-w-0 rounded-xl border bg-card text-card-foreground shadow-card", className)} {...props} />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-sm leading-relaxed text-muted-foreground text-pretty", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
