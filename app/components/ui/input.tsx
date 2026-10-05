import * as React from "react";
import { cn } from "@/lib/utils";

/*
  A field is a white well with a hairline border. Focus brings the border to the
  brand colour and adds a soft halo of it, which reads as "lit" rather than as an
  outline drawn around the box.
*/
const fieldClass =
  "rounded-md border border-input bg-card text-sm shadow-card transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full px-3 py-1 placeholder:text-muted-foreground/70",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        fieldClass,
        className,
      )}
      {...props}
    />
  );
}

export { Input, fieldClass };
