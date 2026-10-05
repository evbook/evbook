import { useEffect, useRef, type RefObject } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { routeCursorAt } from "@/lib/geo";

/** The function a `cursorRef` is filled with: point at a sample, or null to clear. */
export type RouteCursorHandle = (index: number | null) => void;

interface RouteMapProps {
  points: { latitude: number | null; longitude: number | null }[];
  className?: string;
  /**
   * Hover channel from the telemetry chart: the ref is filled with a function that
   * stands a marker on the sample at that index (facing the way the car was going)
   * and clears it on null. A ref rather than state on purpose — hover arrives per
   * mousemove, and carrying it through props would re-render the page and its
   * chart at that rate to move one marker on a map that is imperative anyway.
   */
  cursorRef?: RefObject<RouteCursorHandle | null>;
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

/** Draws a drive's route and fits the map to it. */
export function RouteMap({ points, className, cursorRef }: RouteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cursor = useRef<L.Marker | null>(null);

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

    const coords = points
      .filter((p): p is { latitude: number; longitude: number } => p.latitude != null && p.longitude != null)
      .map((p) => [p.latitude, p.longitude] as [number, number]);

    if (coords.length === 0) {
      instance.setView([0, 0], 2);
      return;
    }

    L.polyline(coords, { color: "#3b5bdb", weight: 4, opacity: 0.85 }).addTo(group);
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    L.circleMarker(first, { radius: 6, color: "#fff", weight: 2, fillColor: "#2f9e44", fillOpacity: 1 })
      .bindTooltip("Start")
      .addTo(group);
    L.circleMarker(last, { radius: 6, color: "#fff", weight: 2, fillColor: "#e03131", fillOpacity: 1 })
      .bindTooltip("End")
      .addTo(group);
    instance.fitBounds(L.latLngBounds(coords), { padding: [24, 24] });
  }, [points]);

  useEffect(() => {
    if (!cursorRef) return;
    cursorRef.current = (index) => {
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
    return () => {
      cursorRef.current = null;
    };
  }, [points, cursorRef]);

  return <div ref={container} className={className} aria-label="Drive route" />;
}
