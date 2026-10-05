import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
  Pills, tinted rather than filled: a wash of the colour behind text in the same
  colour, so a row of them reads as labels and not as buttons. The tints are the
  semantic tokens — brand for "going", success for "charging" — so the same
  meaning is the same colour here as it is on the state band and the battery bar.
*/
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5",
  {
    variants: {
      variant: {
        default: "border-transparent bg-brand/12 text-brand",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/12 text-destructive",
        outline: "bg-card text-foreground shadow-card",
        success: "border-transparent bg-success/14 text-success",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
