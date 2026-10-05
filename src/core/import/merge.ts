/**
 * Joins several time-ordered sample streams into one timeline.
 *
 * Vendors export one file per metric group, each with its own cadence — Tessie
 * writes GPS only when the car moves, climate once a minute, charger state
 * every ten seconds while awake. To rebuild a `vehicle_data` payload we need
 * every metric as of one instant, so tracks are merged on timestamp and each
 * one's last row is carried forward until it goes stale.
 */

export interface TimedRow<T> {
  at: number;
  row: T;
}

export interface MergeTrack<T> {
  name: string;
  /** Rows in ascending `at` order. Duplicate timestamps keep the last row. */
  rows: AsyncIterable<TimedRow<T>>;
  /**
   * How long a row stays valid. A drive's GPS fix describes where the car is
   * parked for as long as it stays there; a charger reading a minute old is
   * already history.
   */
  maxAgeMs: number;
}

export interface MergedSample<T> {
  at: number;
  /** Newest still-valid row per track; null when the track has nothing. */
  tracks: Record<string, T | null>;
  /** Age in ms of each track's row at `at`; 0 means it is from this instant. */
  ages: Record<string, number>;
}

interface Head<T> {
  name: string;
  maxAgeMs: number;
  iterator: AsyncIterator<TimedRow<T>>;
  /** Next row waiting to be merged, or null once the track is exhausted. */
  next: TimedRow<T> | null;
  /** Last row handed out, with the time it was recorded. */
  currentAt: number;
}

/**
 * Yields one sample per distinct timestamp across all tracks, ascending.
 *
 * The yielded object is reused between iterations — read what you need before
 * awaiting again. That keeps a million-snapshot import from allocating a
 * million throwaway objects.
 */
export async function* mergeTracks<T>(tracks: MergeTrack<T>[]): AsyncIterable<MergedSample<T>> {
  const heads: Head<T>[] = [];
  for (const track of tracks) {
    const iterator = track.rows[Symbol.asyncIterator]();
    const first = await iterator.next();
    heads.push({
      name: track.name,
      maxAgeMs: track.maxAgeMs,
      iterator,
      next: first.done ? null : first.value,
      currentAt: -Infinity,
    });
  }

  const sample: MergedSample<T> = { at: 0, tracks: {}, ages: {} };
  for (const head of heads) {
    sample.tracks[head.name] = null;
    sample.ages[head.name] = Infinity;
  }

  try {
    for (;;) {
      let at = Infinity;
      for (const head of heads) {
        if (head.next !== null && head.next.at < at) at = head.next.at;
      }
      if (at === Infinity) return;

      for (const head of heads) {
        // A track may hold several rows for the same instant (a vendor writing
        // twice in one second) — the last one wins.
        while (head.next !== null && head.next.at === at) {
          sample.tracks[head.name] = head.next.row;
          head.currentAt = at;
          const step = await head.iterator.next();
          head.next = step.done ? null : step.value;
          // Guard against an unsorted export: never go backwards.
          if (head.next !== null && head.next.at < at) head.next.at = at;
        }
        const age = at - head.currentAt;
        if (age > head.maxAgeMs) {
          sample.tracks[head.name] = null;
          sample.ages[head.name] = Infinity;
        } else {
          sample.ages[head.name] = age;
        }
      }

      sample.at = at;
      yield sample;
    }
  } finally {
    for (const head of heads) await head.iterator.return?.();
  }
}
