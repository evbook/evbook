import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A value to carry somewhere else — a command, a URL — with a button that copies it. */
export function CopyField({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{value}</code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
