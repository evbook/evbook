import { Link } from "react-router";
import type { TimelineEventDto, TimelineEventKind, TimelineState } from "@shared/api-types";
import type { Units } from "@/lib/units";
import * as u from "@/lib/units";
import { dateOnly, dateTime, money, number, timeOnly } from "@/lib/format";
import { releaseNotesUrl } from "@/lib/firmware";
import { Place, PlacePair } from "@/components/Place";
import { StateSwatch } from "@/components/StateBand";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * The unified event log: one row per thing that happened, whichever table recorded
 * it. The band above it on the page shows the shape of a window; this is what the
 * window actually contained, and the only place a sleep span or a firmware install
 * can be read rather than hovered.
 */

export const KIND_LABELS: Record<TimelineEventKind, string> = {
  drive: "Drive",
  charge: "Charge",
  sleep: "Asleep",
  offline: "Offline",
  update: "Update",
};

/**
 * Which state on the band each kind of event is.
 *
 * The band and this log describe the same window, so an event is worth the same
 * colour in both: a blue row is the blue stripe you were looking at. The badges
 * carry that colour as a chip rather than as their own background, because white
 * text on the amber and green of the palette is not legible at this size — and a
 * chip is what the band's legend already puts beside a state's name.
 */
const EVENT_STATES: Record<TimelineEventKind, TimelineState> = {
  drive: "driving",
  charge: "charging",
  sleep: "asleep",
  offline: "offline",
  update: "updating",
};

/** Drives and charges are the events with a page of their own to link to. */
function detailPath(event: TimelineEventDto): string | null {
  if (event.kind === "drive") return `/drives/${event.id}`;
  if (event.kind === "charge") return `/charges/${event.id}`;
  return null;
}

/** Where it happened: a route for a drive, a place for a charge, a version for an update. */
function Where({ event }: { event: TimelineEventDto }) {
  /*
    An update's "where" is the version it installed, and the question that follows
    an install is always what changed in it — so the version links to its release
    notes, the same link the overview card puts on the firmware the car is on now.
    No link when the string does not parse as a release; see `releaseNotesUrl`.
  */
  if (event.kind === "update") {
    const href = releaseNotesUrl(event.label);
    if (href) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {event.label}
        </a>
      );
    }
  }
  const from = <Place label={event.label} region={event.region} inline />;
  if (event.kind !== "drive") return from;
  // A drive that ended where it began is one place, not an arrow back to itself.
  const sameEnds = event.label === event.endLabel && event.region === event.endRegion;
  if (sameEnds) return from;
  return (
    <PlacePair
      startLabel={event.label}
      startRegion={event.region}
      endLabel={event.endLabel}
      endRegion={event.endRegion}
    />
  );
}

/**
 * What the event moved: distance for a drive, energy for either, nothing for a
 * sleep span. Cost stays in a column of its own, so the two figures a row can carry
 * never have to share a cell.
 */
function amount(event: TimelineEventDto, units: Units): string {
  const parts: string[] = [];
  if (event.distanceKm != null) parts.push(u.distance(event.distanceKm, units, 1));
  if (event.energyKwh != null) parts.push(u.energy(event.energyKwh));
  return parts.length > 0 ? parts.join(" · ") : "–";
}

/**
 * When it ended. The date is repeated whenever it differs from the start's, rather
 * than only the time as on the drives list: a sleep span routinely runs overnight,
 * and "16:29 → 21:08" reads as five hours when the span was twenty-eight.
 */
function ended(event: TimelineEventDto, timezone: string): string {
  if (event.endAt == null) return " → now";
  const sameDay = dateOnly(event.startAt, timezone) === dateOnly(event.endAt, timezone);
  return ` → ${sameDay ? timeOnly(event.endAt, timezone) : dateTime(event.endAt, timezone)}`;
}

function battery(event: TimelineEventDto): string {
  if (event.startBatteryLevel == null || event.endBatteryLevel == null) return "–";
  return `${number(event.startBatteryLevel, 0)} → ${number(event.endBatteryLevel, 0)} %`;
}

export function EventLog({ events, units, timezone }: { events: TimelineEventDto[]; units: Units; timezone: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {/* Kind first: the table scrolls sideways on a phone, and what happened is
              the one column that must never be the part scrolled out of view. */}
          <TableHead>Event</TableHead>
          <TableHead>When</TableHead>
          <TableHead>Where</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">SoC</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => {
          const path = detailPath(event);
          const when = dateTime(event.startAt, timezone);
          return (
            <TableRow key={`${event.kind}-${event.id}`}>
              <TableCell>
                <Badge variant="outline" className="gap-1.5">
                  <StateSwatch state={EVENT_STATES[event.kind]} className="size-2.5" />
                  {KIND_LABELS[event.kind]}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {path ? (
                  <Link to={path} className="font-medium hover:underline">
                    {when}
                  </Link>
                ) : (
                  <span className="font-medium">{when}</span>
                )}
                {/* An event with no end is still going on, which is worth saying
                    outright rather than leaving as a blank arrow. */}
                <span className="text-muted-foreground">{ended(event, timezone)}</span>
              </TableCell>
              <TableCell className="max-w-64 truncate">
                <Where event={event} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {u.duration(event.durationMin != null ? event.durationMin * 60 : null)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{battery(event)}</TableCell>
              <TableCell className="text-right tabular-nums">{amount(event, units)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(event.costCents, units.currency)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
