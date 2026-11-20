import { describe, expect, it } from "bun:test";
import { encodePolyline, type LatLng } from "@shared/polyline";
import { countDrives, heatImage, heatOf, HEAT_PALETTE, peakOf, projectTracks, tracksBounds } from "./density";

/** A view of `size` pixels square whose pixels are a thousandth of a degree of longitude at the equator. */
function viewAt(longitude: number, latitude: number, size = 40) {
  const scale = 360_000;
  return {
    scale,
    left: Math.floor(((longitude + 180) / 360) * scale),
    top: Math.floor(projectTracks([encodePolyline([[latitude, 0]])])[0]!.xy[1]! * scale),
    width: size,
    height: size,
  };
}

const eastward = (latitude: number, from = 0.005, to = 0.03): LatLng[] => [
  [latitude, from],
  [latitude, to],
];

describe("projectTracks", () => {
  it("puts the equator and the meridian in the middle of the world", () => {
    const [track] = projectTracks([encodePolyline([[0, 0]])]);
    expect(track!.xy[0]).toBeCloseTo(0.5, 9);
    expect(track!.xy[1]).toBeCloseTo(0.5, 9);
  });

  it("drops a track with nothing in it and boxes the rest", () => {
    const tracks = projectTracks([
      "",
      encodePolyline(eastward(52.5, 13.3, 13.5)),
      encodePolyline(eastward(48.1, 11.5, 11.6)),
    ]);
    expect(tracks).toHaveLength(2);
    const bounds = tracksBounds(tracks)!;
    expect(bounds.south).toBeCloseTo(48.1, 4);
    expect(bounds.north).toBeCloseTo(52.5, 4);
    expect(bounds.west).toBeCloseTo(11.5, 4);
    expect(bounds.east).toBeCloseTo(13.5, 4);
    expect(tracksBounds([])).toBeNull();
  });
});

describe("countDrives", () => {
  it("counts the drives through a pixel, not the samples", () => {
    const there = eastward(-0.01);
    // Out and back along the same street is still one drive down it.
    const thereAndBack: LatLng[] = [...there, there[0]!];
    const tracks = projectTracks([encodePolyline(there), encodePolyline(there), encodePolyline(thereAndBack)]);
    const view = viewAt(0, 0);
    const counts = countDrives(tracks, view);
    expect(peakOf(counts)).toBe(3);
    // One row of pixels, from the fifth to the thirtieth thousandth of a degree.
    const lit = [...counts].filter((count) => count > 0);
    expect(lit.length).toBeGreaterThanOrEqual(25);
    expect(lit.length).toBeLessThanOrEqual(27);
    expect(new Set(lit)).toEqual(new Set([3]));
  });

  it("keeps roads apart and adds them up only where they cross", () => {
    const across = eastward(-0.02);
    const down: LatLng[] = [
      [-0.005, 0.02],
      [-0.035, 0.02],
    ];
    const counts = countDrives(projectTracks([encodePolyline(across), encodePolyline(down)]), viewAt(0, 0));
    expect(peakOf(counts)).toBe(2);
    expect([...counts].filter((count) => count === 2)).toHaveLength(1);
  });

  it("draws only the part of a long leg that is in view, the same from either side of a seam", () => {
    // A leg from far west of the view to far east of it, on a slope.
    const leg = projectTracks([
      encodePolyline([
        [-0.012, -3],
        [-0.022, 3],
      ]),
    ]);
    const whole = viewAt(0, 0, 40);
    const all = countDrives(leg, whole);
    // Unbroken: every column of the view has the line in it.
    for (let x = 0; x < 40; x++) {
      expect(Array.from({ length: 40 }, (_, y) => all[y * 40 + x]!).some((count) => count > 0)).toBe(true);
    }
    expect([...all].filter((count) => count > 0).length).toBeLessThanOrEqual(42);

    // The right-hand half on its own marks exactly the pixels the whole view did.
    const right = countDrives(leg, { ...whole, left: whole.left + 20, width: 20 });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 20; x++) expect(right[y * 20 + x]).toBe(all[y * 40 + x + 20]!);
    }
  });

  it("is empty for a view the drives never reach", () => {
    const counts = countDrives(projectTracks([encodePolyline(eastward(-0.01))]), viewAt(10, 0));
    expect(peakOf(counts)).toBe(0);
  });

  it("marks a drive that never left one spot", () => {
    const counts = countDrives(projectTracks([encodePolyline([[-0.01, 0.01]])]), viewAt(0, 0));
    expect([...counts].filter((count) => count > 0)).toHaveLength(1);
  });
});

describe("heatOf", () => {
  it("shows a road driven once, and the busiest at full heat", () => {
    expect(heatOf(0, 200)).toBe(0);
    expect(heatOf(1, 200)).toBeGreaterThan(0.3);
    expect(heatOf(1, 200)).toBeLessThan(0.5);
    expect(heatOf(200, 200)).toBe(1);
    expect(heatOf(500, 200)).toBe(1);
  });

  it("rises with the count, by ratio rather than by difference", () => {
    const steps = [1, 4, 16, 64, 256].map((count) => heatOf(count, 256));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]! - steps[i - 1]!).toBeCloseTo(steps[1]! - steps[0]!, 9);
    }
  });

  it("does not call two drives on one street the top of the scale", () => {
    expect(heatOf(2, 2)).toBeLessThan(0.7);
  });
});

describe("heatImage", () => {
  it("leaves empty ground clear and paints a road, hottest down its middle", () => {
    const width = 21;
    const counts = new Uint16Array(width * width);
    for (let x = 0; x < width; x++) counts[10 * width + x] = 50;
    const image = heatImage(counts, width, width, 50, 2);
    const alpha = (x: number, y: number) => image[(y * width + x) * 4 + 3]!;

    expect(alpha(10, 0)).toBe(0);
    expect(alpha(10, 10)).toBe(255);
    // Fading out either side, and gone past twice the radius.
    expect(alpha(10, 13)).toBeGreaterThan(0);
    expect(alpha(10, 13)).toBeLessThan(alpha(10, 11));
    expect(alpha(10, 15)).toBe(0);
    // The middle is the top of the palette.
    expect([...image.slice((10 * width + 10) * 4, (10 * width + 10) * 4 + 3)]).toEqual([
      ...HEAT_PALETTE.slice(255 * 4, 255 * 4 + 3),
    ]);
  });
});
