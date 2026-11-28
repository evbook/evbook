import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { routeCursorAt, trackStretches } from "@/lib/geo";
import { SPEED_GRADIENT, SPEED_SCALE_TOP_KMH, SPEED_UNKNOWN_COLOR, speedRuns } from "@/lib/speedColor";
import { cn } from "@/lib/utils";

/** The function a `cursorRef` is filled with: point at a sample, or null to clear. */
export type RouteCursorHandle = (index: number | null) => void;

interface RouteMapProps {
  /**
   * The track. With `at` (epoch ms) on every sample, a stretch the car reported
   * no position along is drawn dashed (`trackStretches`); without it — a trip's
   * thinned path — the whole track is drawn as recorded.
   */
  points: { at?: number; latitude: number | null; longitude: number | null; speedKmh?: number | null }[];
  className?: string;
  /**
   * Colours the line by how fast the car was going, and says so in a legend read
   * in this unit. Left out — or given a track nobody read a speed on — the route
   * is the one plain line.
   */
  speedScale?: "km" | "mi";
  /**
   * Hover channel from the telemetry chart: the ref is filled with a function that
   * stands a marker on the sample at that index (facing the way the car was going)
   * and clears it on null. A ref rather than state on purpose — hover arrives per
   * mousemove, and carrying it through props would re-render the page and its
   * chart at that rate to move one marker on a map that is imperative anyway.
   */
  cursorRef?: RefObject<RouteCursorHandle | null>;
  /**
   * Makes the route hoverable: over the line the pointer becomes the cursor's
   * direction arrow, stood on the nearest sample, and this draws the popup shown
   * beside it — the telemetry chart's own, for that sample. Called with an index
   * into `points`; null shows the arrow alone.
   */
  popup?: (index: number) => ReactNode;
  /** Told the index into `points` the route hover is on, and null when it leaves. */
  onHover?: (index: number | null) => void;
}

/**
 * The chart cursor's marker. The arrow is drawn pointing north so the rotation
 * applied to it *is* the compass heading; when the track offers no heading the
 * dot shows instead — a direction would be invented, the place never is.
 */
const CURSOR_HTML = `
  <div style="position:relative;width:22px;height:22px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))">
    <svg data-arrow viewBox="0 0 24 24" width="22" height="22" style="position:absolute;inset:0;transform-origin:50% 50%;display:none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.36328 12.0523C4.01081 11.5711 3.33457 11.3304 3.13309 10.9655C2.95849 10.6492 2.95032 10.2673 3.11124 9.94388C3.29694 9.57063 3.96228 9.30132 5.29295 8.76272L17.8356 3.68594C19.1461 3.15547 19.8014 2.89024 20.2154 3.02623C20.5747 3.14427 20.8565 3.42608 20.9746 3.7854C21.1106 4.19937 20.8453 4.85465 20.3149 6.16521L15.2381 18.7078C14.6995 20.0385 14.4302 20.7039 14.0569 20.8896C13.7335 21.0505 13.3516 21.0423 13.0353 20.8677C12.6704 20.6662 12.4297 19.99 11.9485 18.6375L10.4751 14.4967C10.3815 14.2336 10.3347 14.102 10.2582 13.9922C10.1905 13.8948 10.106 13.8103 10.0086 13.7426C9.89876 13.6661 9.76719 13.6193 9.50407 13.5257L5.36328 12.0523Z" fill="#3b5bdb" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span data-dot style="position:absolute;left:5px;top:5px;width:12px;height:12px;border-radius:9999px;background:#3b5bdb;border:2px solid #fff;display:none"></span>
  </div>`;

/** The artwork's tip sits at 45° (upper right); subtracted so 0 means north. */
const CURSOR_ART_DEG = 45;

const cursorIcon = () =>
  // className replaces leaflet-div-icon, whose default white box would frame the arrow.
  L.divIcon({ className: "route-cursor", html: CURSOR_HTML, iconSize: [22, 22], iconAnchor: [11, 11] });

/** How close to the line, in screen pixels, the pointer counts as over it. */
const HOVER_HIT_PX = 14;

/** Gap between the arrow and the popup beside it, and between the popup and the map's edge. */
const POPUP_GAP_PX = 16;
const POPUP_EDGE_PX = 8;

const MILES_PER_KM = 0.62137119223733;

const ROUTE_COLOR = "#3b5bdb";

type Located = { at?: number; latitude: number; longitude: number; speedKmh?: number | null };

/** The track as recorded stretches and dashed gaps, or all recorded when it has no times. */
function stretchesOf(located: Located[]): { recorded: boolean; points: Located[] }[] {
  if (located.length > 0 && located.every((p) => p.at != null)) {
    return trackStretches(located as (Located & { at: number })[]);
  }
  return [{ recorded: true, points: located }];
}

/** Draws a drive's route and fits the map to it. */
export function RouteMap({ points, className, cursorRef, speedScale, popup, onHover }: RouteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cursor = useRef<L.Marker | null>(null);
  // Stands the arrow on a sample, or clears it. The chart's hover and a hover on
  // the route itself both move the one marker through this.
  const placeCursor = useRef<RouteCursorHandle>(() => {});
  // The sample hovered on the map, and where it sits in the map's own pixels.
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const popupBox = useRef<HTMLDivElement>(null);
  const hoverable = popup != null;
  // The latest callback, read at hover time so a new one each render does not
  // tear down and rebuild the map's listeners.
  const reportHover = useRef(onHover);
  useEffect(() => {
    reportHover.current = onHover;
  });
  const bySpeed = speedScale != null && points.some((p) => p.speedKmh != null);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);
    map.current = instance;
    layer.current = L.layerGroup().addTo(instance);
    return () => {
      instance.remove();
      map.current = null;
      layer.current = null;
      cursor.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const group = layer.current;
    if (!instance || !group) return;
    group.clearLayers();
    // The sweep just took the cursor marker with it; drop the stale handle so the
    // next hover builds a fresh one instead of moving a marker that is off the map.
    cursor.current = null;

    const located = points.filter((p): p is Located => p.latitude != null && p.longitude != null);
    const coords = located.map((p) => [p.latitude, p.longitude] as [number, number]);

    if (coords.length === 0) {
      instance.setView([0, 0], 2);
      return;
    }

    const line = (stretch: Located[]) => stretch.map((p) => [p.latitude, p.longitude] as [number, number]);
    for (const stretch of stretchesOf(located)) {
      if (!stretch.recorded) {
        // A straight line across minutes the car reported no position: thinner
        // and dashed, and never speed-coloured — nobody read a speed along it.
        L.polyline(line(stretch.points), {
          color: bySpeed ? SPEED_UNKNOWN_COLOR : ROUTE_COLOR,
          weight: 3,
          opacity: 0.9,
          dashArray: "6 8",
          lineCap: "butt",
          interactive: false,
        }).addTo(group);
      } else if (bySpeed) {
        // A dark edge under the colours: the middle of the scale is a yellow that
        // the light map would otherwise swallow.
        L.polyline(line(stretch.points), { color: "#16181d", weight: 7, opacity: 0.45, interactive: false }).addTo(
          group,
        );
        for (const run of speedRuns(stretch.points.map((p) => ({ ...p, speedKmh: p.speedKmh ?? null })))) {
          // Opaque, because runs overlap where they meet and a see-through line
          // would show every join as a darker bead.
          L.polyline(run.coords, { color: run.color, weight: 4, opacity: 1, interactive: false }).addTo(group);
        }
      } else {
        L.polyline(line(stretch.points), { color: ROUTE_COLOR, weight: 4, opacity: 0.85, interactive: false }).addTo(
          group,
        );
      }
    }
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    L.circleMarker(first, { radius: 6, color: "#fff", weight: 2, fillColor: "#2f9e44", fillOpacity: 1 })
      .bindTooltip("Start")
      .addTo(group);
    L.circleMarker(last, { radius: 6, color: "#fff", weight: 2, fillColor: "#e03131", fillOpacity: 1 })
      .bindTooltip("End")
      .addTo(group);
    instance.fitBounds(L.latLngBounds(coords), { padding: [24, 24] });
  }, [points, bySpeed]);

  useEffect(() => {
    placeCursor.current = (index) => {
      const group = layer.current;
      if (!group) return;
      const target = index == null ? null : routeCursorAt(points, index);
      if (!target) {
        cursor.current?.remove();
        cursor.current = null;
        return;
      }
      if (!cursor.current) {
        cursor.current = L.marker([target.latitude, target.longitude], {
          icon: cursorIcon(),
          // Above the start/end markers, and transparent to the mouse so a hover
          // over the map itself still reaches the route underneath.
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        }).addTo(group);
      } else {
        cursor.current.setLatLng([target.latitude, target.longitude]);
      }
      const element = cursor.current.getElement();
      const arrow = element?.querySelector<SVGElement>("[data-arrow]");
      const dot = element?.querySelector<HTMLElement>("[data-dot]");
      if (!arrow || !dot) return;
      arrow.style.display = target.headingDeg == null ? "none" : "";
      dot.style.display = target.headingDeg == null ? "" : "none";
      if (target.headingDeg != null) {
        arrow.style.transform = `rotate(${target.headingDeg - CURSOR_ART_DEG}deg)`;
      }
    };
  }, [points]);

  useEffect(() => {
    if (!cursorRef) return;
    cursorRef.current = (index) => placeCursor.current(index);
    return () => {
      cursorRef.current = null;
    };
  }, [cursorRef]);

  /*
    Hovering the route. The hit test is against the segments between samples, not
    the samples alone, so a sparsely reported drive (a position every few minutes)
    still answers anywhere along its line; the arrow then snaps to the nearer end.
    Screen positions are projected once per view and dropped whenever the map pans
    or zooms.
  */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !hoverable) return;
    const box = instance.getContainer();
    const located = points.flatMap((p, index) =>
      p.latitude != null && p.longitude != null ? [{ index, latLng: L.latLng(p.latitude, p.longitude) }] : [],
    );
    let screen: L.Point[] | null = null;
    let current: number | null = null;

    const clear = () => {
      if (current == null) return;
      current = null;
      box.classList.remove("route-hovering");
      placeCursor.current(null);
      setHover(null);
      reportHover.current?.(null);
    };
    // The located sample nearest the pointer, when the pointer is on the line.
    const nearest = (m: L.Point): number | null => {
      screen ??= located.map((p) => instance.latLngToContainerPoint(p.latLng));
      if (screen.length === 1) return m.distanceTo(screen[0]!) <= HOVER_HIT_PX ? 0 : null;
      let best: number | null = null;
      let bestDistance = HOVER_HIT_PX;
      for (let i = 1; i < screen.length; i++) {
        const a = screen[i - 1]!;
        const b = screen[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / length2));
        const distance = Math.hypot(m.x - (a.x + t * dx), m.y - (a.y + t * dy));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = t < 0.5 ? i - 1 : i;
        }
      }
      return best;
    };
    const move = (event: L.LeafletMouseEvent) => {
      const hit = nearest(event.containerPoint);
      if (hit == null) return clear();
      const { index } = located[hit]!;
      if (index === current) return;
      current = index;
      box.classList.add("route-hovering");
      placeCursor.current(index);
      const at = screen![hit]!;
      setHover({ index, x: at.x, y: at.y });
      reportHover.current?.(index);
    };
    const moved = () => {
      screen = null;
      clear();
    };

    instance.on("mousemove", move);
    instance.on("mouseout", clear);
    instance.on("movestart zoomstart", moved);
    return () => {
      instance.off("mousemove", move);
      instance.off("mouseout", clear);
      instance.off("movestart zoomstart", moved);
      clear();
    };
  }, [points, hoverable]);

  // Beside the arrow, on whichever side has room, and held inside the map.
  useLayoutEffect(() => {
    const element = popupBox.current;
    const frame = container.current;
    if (!hover || !element || !frame) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const fitsRight = hover.x + POPUP_GAP_PX + width <= frame.clientWidth - POPUP_EDGE_PX;
    const left = fitsRight ? hover.x + POPUP_GAP_PX : Math.max(POPUP_EDGE_PX, hover.x - POPUP_GAP_PX - width);
    const top = Math.max(POPUP_EDGE_PX, Math.min(hover.y - height / 2, frame.clientHeight - height - POPUP_EDGE_PX));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [hover]);

  const popupContent = hover && popup ? popup(hover.index) : null;

  const top = Math.round(speedScale === "mi" ? SPEED_SCALE_TOP_KMH * MILES_PER_KM : SPEED_SCALE_TOP_KMH);

  return (
    // The map fills a wrapper rather than being it, so the legend can sit over
    // the map without living inside Leaflet's own container.
    <div className={cn("relative overflow-hidden", className)}>
      <div ref={container} className="h-full w-full" aria-label="Drive route" />
      {hover && popupContent != null && (
        // Placed by the layout effect above once its size is known; hidden until then.
        <div
          key={hover.index}
          ref={popupBox}
          className="pointer-events-none absolute z-[1000]"
          style={{ visibility: "hidden" }}
        >
          {popupContent}
        </div>
      )}
      {bySpeed && (
        <div
          className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-md border bg-card/85 px-2 py-1.5 text-[10px] leading-none text-muted-foreground backdrop-blur"
          aria-label={`Line colour shows speed, from 0 to ${top} ${speedScale === "mi" ? "mph" : "km/h"} and over`}
        >
          <div className="h-1.5 w-28 rounded-full" style={{ background: SPEED_GRADIENT }} />
          <div className="mt-1 flex justify-between tabular-nums">
            <span>0</span>
            <span>
              {top}+ {speedScale === "mi" ? "mph" : "km/h"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
