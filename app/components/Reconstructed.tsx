import { Badge } from "@/components/ui/badge";

/**
 * The mark on an event nobody saw: EVBook could not read the car (asleep,
 * offline, a lapsed token, the server down) and the odometer or the state of
 * charge moved meanwhile. The badge says so wherever the event is listed, so a
 * reader never takes its "between" for a measured time.
 */
export function ReconstructedBadge({ kind }: { kind: "drive" | "charge" }) {
  const what = kind === "drive" ? "The odometer moved" : "The state of charge rose";
  return (
    <Badge
      variant="outline"
      className="px-1.5 py-0 align-middle text-[11px] font-normal text-muted-foreground"
      title={`${what} while EVBook could not read the car. When exactly, and how long it took, is unknown.`}
    >
      Reconstructed
    </Badge>
  );
}
