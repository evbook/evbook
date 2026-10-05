import { describe, expect, it } from "vitest";
import { detectTrips, TRIP_DEFAULTS, type TripDrive, type TripPlace } from "./trips";

/** Known-answer tests for the trip boundary rules. */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 5, 1, 8);

/**
 * A place resolved as an address only, which is the common case: nearly every
 * drive geocodes, and only the fenced few carry a geofence too.
 */
function place(name: string | null): TripPlace {
  return { geofence: null, address: name };
}

/** A drive an hour long, from one place to another. */
function drive(opts: {
  id: number;
  at: number;
  km: number;
  from: string | null;
  to: string | null;
  hours?: number;
}): TripDrive {
  const length = (opts.hours ?? 1) * HOUR;
  return {
    id: opts.id,
    startAt: opts.at,
    endAt: opts.at + length,
    distanceKm: opts.km,
    durationMin: length / 60_000,
    energyKwh: opts.km * 0.18,
    startLabel: opts.from,
    endLabel: opts.to,
    // Grouping never looks at the region; the labels alone carry the fixture.
    startRegion: null,
    endRegion: null,
    startPlace: place(opts.from),
    endPlace: place(opts.to),
    // Grouping never looks at coordinates either; they are for naming, which
    // happens a layer up.
    startLat: null,
    startLon: null,
    endLat: null,
    endLon: null,
    startBatteryLevel: 80,
    endBatteryLevel: 60,
  };
}

/** `now` far enough ahead that the last run is always closed by rule 2. */
const detect = (drives: TripDrive[], now = START + 30 * DAY) =>
  detectTrips(drives, { ...TRIP_DEFAULTS, now });

describe("trip detection", () => {
  it("keeps a run together across an overnight stop away from home", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 300, from: "home", to: "hotel" }),
      drive({ id: 2, at: START + 20 * HOUR, km: 250, from: "hotel", to: "lake" }),
      drive({ id: 3, at: START + 40 * HOUR, km: 400, from: "lake", to: "home" }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.drives.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it("ends a trip when the car is back where it started for a couple of hours", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 300, from: "home", to: "coast" }),
      drive({ id: 2, at: START + 5 * HOUR, km: 300, from: "coast", to: "home" }),
      // Same day, and far enough to qualify on its own, but the car came home in between.
      drive({ id: 3, at: START + 12 * HOUR, km: 200, from: "home", to: "friends" }),
      drive({ id: 4, at: START + 16 * HOUR, km: 200, from: "friends", to: "home" }),
    ]);

    expect(trips.map((t) => t.drives.map((d) => d.id))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("does not end a trip on a short turnaround at the starting place", () => {
    // Home for twenty minutes to swap bags is not the end of the journey.
    const trips = detect([
      drive({ id: 1, at: START, km: 120, from: "home", to: "office" }),
      drive({ id: 2, at: START + 2 * HOUR, km: 120, from: "office", to: "home" }),
      drive({ id: 3, at: START + 3 * HOUR + 20 * 60_000, km: 300, from: "home", to: "coast" }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.drives).toHaveLength(3);
  });

  it("ends a run after two days parked wherever it is", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 300, from: "home", to: "airport" }),
      drive({ id: 2, at: START + HOUR * 2, km: 100, from: "airport", to: "storage" }),
      // Three days later, and never back to where it began.
      drive({ id: 3, at: START + 3 * DAY, km: 200, from: "storage", to: "coast" }),
      drive({ id: 4, at: START + 3 * DAY + 4 * HOUR, km: 200, from: "coast", to: "storage" }),
    ]);

    expect(trips.map((t) => t.drives.map((d) => d.id))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("leaves the commute out of it", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 25, from: "home", to: "work" }),
      drive({ id: 2, at: START + 9 * HOUR, km: 25, from: "work", to: "home" }),
      drive({ id: 3, at: START + DAY, km: 25, from: "home", to: "work" }),
      drive({ id: 4, at: START + DAY + 9 * HOUR, km: 25, from: "work", to: "home" }),
    ]);

    expect(trips).toEqual([]);
  });

  it("leaves a single long drive out of it, however far it went", () => {
    const trips = detect([drive({ id: 1, at: START, km: 900, from: "home", to: "coast", hours: 9 })]);
    expect(trips).toEqual([]);
  });

  it("reports the newest run as open while the car is still away", () => {
    const drives = [
      drive({ id: 1, at: START, km: 300, from: "home", to: "hotel" }),
      drive({ id: 2, at: START + 20 * HOUR, km: 250, from: "hotel", to: "lake" }),
    ];

    const open = detectTrips(drives, { ...TRIP_DEFAULTS, now: START + 22 * HOUR });
    expect(open[0]!.closed).toBe(false);

    // Same drives, read a week later: nothing followed, so the journey is over.
    const later = detectTrips(drives, { ...TRIP_DEFAULTS, now: START + 8 * DAY });
    expect(later[0]!.closed).toBe(true);
  });

  it("counts a return as closing the trip only once the car has settled", () => {
    const drives = [
      drive({ id: 1, at: START, km: 300, from: "home", to: "coast" }),
      drive({ id: 2, at: START + 5 * HOUR, km: 300, from: "coast", to: "home" }),
    ];

    // Home half an hour ago: could still be a stop in the middle of the journey.
    expect(detectTrips(drives, { ...TRIP_DEFAULTS, now: START + 6.5 * HOUR })[0]!.closed).toBe(false);
    expect(detectTrips(drives, { ...TRIP_DEFAULTS, now: START + 9 * HOUR })[0]!.closed).toBe(true);
  });

  /*
    Rule 1 needs to know where the run began, and when the opening drive's start
    place never resolved it falls back to where that drive *ended* — which is where
    the next drive leaves from, so it is the place a return comes back to. Reading
    ahead to a later drive's start instead left the origin unknown at the moment the
    run's own first gap was tested, so the errand below was glued onto the front of
    the journey, and whether that happened depended on whether the geocoder had
    resolved one address that had nothing to do with the trip.
  */
  it("closes a run at an unresolved opening drive's destination", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 60, from: null, to: "home" }),
      drive({ id: 2, at: START + 4 * HOUR, km: 300, from: "home", to: "coast" }),
      drive({ id: 3, at: START + 9 * HOUR, km: 300, from: "coast", to: "home" }),
      drive({ id: 4, at: START + DAY, km: 300, from: "home", to: "coast" }),
      drive({ id: 5, at: START + DAY + 5 * HOUR, km: 300, from: "coast", to: "home" }),
    ]);

    expect(trips.map((t) => t.drives.map((d) => d.id))).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  /*
    The three shapes a history that was imported over live data, or recorded twice,
    can present. All of them used to lose a journey outright, because the gap was
    measured from the last row's end rather than from the furthest end so far.
  */
  it("survives a drive row whose end precedes its own start", () => {
    const backwards = drive({ id: 1, at: START, km: 300, from: "home", to: "coast" });
    const trips = detect([
      { ...backwards, endAt: START - 10 * DAY },
      drive({ id: 2, at: START + 3 * HOUR, km: 300, from: "coast", to: "home" }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.drives.map((d) => d.id)).toEqual([1, 2]);
  });

  it("survives a duplicate row overlapping the drive it duplicates", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 400, from: "home", to: "coast", hours: 12 }),
      // Recorded inside the drive above, and apparently already back home.
      drive({ id: 2, at: START + HOUR, km: 100, from: "coast", to: "home" }),
      drive({ id: 3, at: START + 13 * HOUR, km: 400, from: "coast", to: "home" }),
    ]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.drives.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it("sorts its input rather than trusting it", () => {
    const drives = [
      drive({ id: 1, at: START, km: 300, from: "home", to: "coast" }),
      drive({ id: 2, at: START + 5 * HOUR, km: 300, from: "coast", to: "home" }),
    ];

    expect(detect([...drives].reverse())).toEqual(detect(drives));
  });

  /*
    Short hops go unrecorded, so a run can open with a drive that starts a
    kilometre from where the car was left. The origin is where the car was
    *parked* when the run began — the end of the drive before it — not the stray
    point the opening drive starts from. Taking the stray point made the origin a
    kindergarten forecourt the car never "returned" to, rule 1 went dead, and a
    week of school runs glued into one open journey.
  */
  it("takes the parked place as the origin when the opening drive starts elsewhere", () => {
    const trips = detect([
      // An errand that ends at home, closing its run there two and a half hours on.
      drive({ id: 1, at: START, km: 5, from: "home", to: "home" }),
      // The next run opens at the kindergarten — the hop from home was never recorded.
      drive({ id: 2, at: START + 3.5 * HOUR, km: 60, from: "kindergarten", to: "hills" }),
      drive({ id: 3, at: START + 6 * HOUR, km: 60, from: "hills", to: "home" }),
      // Overnight at home has to close that run, or the next day glues onto it.
      drive({ id: 4, at: START + 23 * HOUR, km: 60, from: "home", to: "coast" }),
      drive({ id: 5, at: START + 26 * HOUR, km: 60, from: "coast", to: "home" }),
    ]);

    expect(trips.map((t) => t.drives.map((d) => d.id))).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  /*
    A place has two names — the geofence around it and the address under it — and
    they do not fail together. The day the returning drive parks a metre outside
    the fence, only the address resolves, and comparing coalesced single keys read
    that as somewhere else entirely and kept the journey open.
  */
  it("recognises the return when only the address, not the geofence, resolved", () => {
    const out = drive({ id: 1, at: START, km: 300, from: "home", to: "coast" });
    out.startPlace = { geofence: "home-fence", address: "home-street" };
    const back = drive({ id: 2, at: START + 8 * HOUR, km: 300, from: "coast", to: "home" });
    back.endPlace = { geofence: null, address: "home-street" };

    const trips = detectTrips([out, back], { ...TRIP_DEFAULTS, now: START + 12 * HOUR });
    expect(trips).toHaveLength(1);
    expect(trips[0]!.closed).toBe(true);
  });

  /*
    An import replayed over live data wrote a batch of drives twice under fresh
    ids. Each pair rendered as "stayed 0 s" at a street passed once, and the
    journey's distance counted double.
  */
  it("counts a drive the import wrote twice once", () => {
    const out = drive({ id: 1, at: START, km: 300, from: "home", to: "coast" });
    const again = { ...out, id: 7 };
    const back = drive({ id: 2, at: START + 5 * HOUR, km: 300, from: "coast", to: "home" });

    const trips = detect([out, again, back]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.drives.map((d) => d.id)).toEqual([1, 2]);
  });

  /*
    The two corruptions together, which is how the import actually wrote them: a
    twice-written batch of split segments. Every copy after the first merge used
    to slip through, because it was compared against a joined row whose start had
    moved.
  */
  it("counts a twice-written batch of split segments once", () => {
    const first = drive({ id: 1, at: START, km: 200, from: "home", to: "roundabout" });
    const second = drive({ id: 2, at: START + HOUR + 60_000, km: 200, from: "roundabout", to: "coast" });
    const back = drive({ id: 5, at: START + 9 * HOUR, km: 400, from: "coast", to: "home" });

    const trips = detect([first, { ...first, id: 3 }, second, { ...second, id: 4 }, back]);

    expect(trips).toHaveLength(1);
    const drives = trips[0]!.drives;
    expect(drives.map((d) => d.id)).toEqual([1, 5]);
    expect(drives[0]!.distanceKm).toBe(400);
  });

  /*
    The recorder loses a drive for a minute and hands back two rows. That pause is
    a traffic queue, not a stop on the itinerary — and two halves of one drive must
    not count as the two drives a trip needs.
  */
  it("joins a drive the recorder split, and does not call the pause a stop", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 200, from: "home", to: "roundabout" }),
      // One minute after the first half ends, the second begins.
      drive({ id: 2, at: START + HOUR + 60_000, km: 200, from: "roundabout", to: "coast" }),
      drive({ id: 3, at: START + 8 * HOUR, km: 400, from: "coast", to: "home" }),
    ]);

    expect(trips).toHaveLength(1);
    const drives = trips[0]!.drives;
    expect(drives.map((d) => d.id)).toEqual([1, 3]);
    expect(drives[0]!.distanceKm).toBe(400);
    expect(drives[0]!.endLabel).toBe("coast");
  });

  it("does not let a split single drive pass for the two drives a trip needs", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 450, from: "home", to: "halfway" }),
      drive({ id: 2, at: START + HOUR + 90_000, km: 450, from: "halfway", to: "coast" }),
    ]);

    expect(trips).toEqual([]);
  });

  /*
    Lunch at home between two outings is the end of the first one. Eighty minutes
    did not count as "back" under a two-hour threshold, so a morning errand was
    glued onto the front of an afternoon journey and the trip opened two and a
    half hours before anyone left.
  */
  it("ends a run over lunch at home, so the afternoon is its own journey", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 10, from: "home", to: "shop", hours: 0.5 }),
      drive({ id: 2, at: START + HOUR, km: 10, from: "shop", to: "home", hours: 0.5 }),
      // An hour and twenty at home, then off on the real trip.
      drive({ id: 3, at: START + 2.5 * HOUR + 20 * 60_000, km: 150, from: "home", to: "lake" }),
      drive({ id: 4, at: START + 6 * HOUR, km: 150, from: "lake", to: "home" }),
    ]);

    expect(trips.map((t) => t.drives.map((d) => d.id))).toEqual([[3, 4]]);
  });

  it("keeps a run whose places never resolved, on distance alone", () => {
    const trips = detect([
      drive({ id: 1, at: START, km: 300, from: null, to: null }),
      drive({ id: 2, at: START + 5 * HOUR, km: 300, from: null, to: null }),
    ]);

    expect(trips).toHaveLength(1);
  });

  it("handles no drives at all", () => {
    expect(detect([])).toEqual([]);
  });
});
