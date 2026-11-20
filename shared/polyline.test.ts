import { describe, expect, it } from "bun:test";
import { decodePolyline, encodePolyline, type LatLng } from "./polyline";

describe("polyline", () => {
  it("matches the published example of the format", () => {
    const track: LatLng[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(track)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual(track);
  });

  it("round-trips a track to within a metre, either side of the equator and the meridian", () => {
    const track: LatLng[] = [
      [52.520008, 13.404954],
      [52.519, 13.41],
      [-33.86882, 151.20929],
      [0, 0],
      [-0.00001, -0.00001],
    ];
    const decoded = decodePolyline(encodePolyline(track));
    expect(decoded).toHaveLength(track.length);
    decoded.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(track[i]![0], 5);
      expect(lng).toBeCloseTo(track[i]![1], 5);
    });
  });

  it("writes a spot the car sat on once", () => {
    const waiting: LatLng[] = [
      [52.5, 13.4],
      [52.5000001, 13.4000001],
      [52.5, 13.4],
      [52.51, 13.4],
    ];
    expect(decodePolyline(encodePolyline(waiting))).toEqual([
      [52.5, 13.4],
      [52.51, 13.4],
    ]);
  });

  it("is empty for no points, and stops at a cut-off string", () => {
    expect(encodePolyline([])).toBe("");
    expect(decodePolyline("")).toEqual([]);
    // The second point's longitude is missing.
    expect(decodePolyline("_p~iF~ps|U_ulL")).toEqual([[38.5, -120.2]]);
  });
});
