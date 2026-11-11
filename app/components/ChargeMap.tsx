import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ChargeMapPointDto } from "@shared/api-types";
import type { CurrencyCode } from "@shared/currency";
import { cost, dateOnly, rate } from "@/lib/format";
import * as u from "@/lib/units";

interface ChargeMapProps {
  points: ChargeMapPointDto[];
  timezone: string;
  currency: CurrencyCode;
  className?: string;
}

const MIN_SIZE = 28;
const MAX_SIZE = 54;

/**
 * How close two bubbles may be, in pixels, before they are drawn as one. Just
 * under the widest bubble, so overlapping places merge but neighbours that only
 * touch stay apart.
 */
const MERGE_DISTANCE = MAX_SIZE * 0.8;

/** One bubble: a single place, or the places too close together to tell apart. */
interface Bubble {
  places: ChargeMapPointDto[];
  latitude: number;
  longitude: number;
  count: number;
  energyKwh: number | null;
  costCents: number | null;
  lastAt: number;
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

/**
 * Group the places that overlap at the current zoom. Busiest first, so a
 * cluster sits on its most-used place rather than drifting to a centroid
 * between two chargers — and zooming in splits it back apart.
 */
function bubblesFor(map: L.Map, points: ChargeMapPointDto[]): Bubble[] {
  const groups: { anchor: L.Point; places: ChargeMapPointDto[] }[] = [];
  for (const point of [...points].sort((a, b) => b.count - a.count)) {
    const at = map.latLngToLayerPoint([point.latitude, point.longitude]);
    const near = groups.find((group) => group.anchor.distanceTo(at) < MERGE_DISTANCE);
    if (near) near.places.push(point);
    else groups.push({ anchor: at, places: [point] });
  }

  return groups.map(({ places }) => {
    const head = places[0]!;
    return {
      places,
      latitude: head.latitude,
      longitude: head.longitude,
      count: places.reduce((total, place) => total + place.count, 0),
      energyKwh: sum(places.map((place) => place.energyKwh)),
      costCents: sum(places.map((place) => place.costCents)),
      lastAt: Math.max(...places.map((place) => place.lastAt)),
    };
  });
}

/**
 * Bubble diameter, against the busiest one on the map. Area tracks the session
 * count rather than width: a bubble twice as wide covers four times the ground
 * and reads as far more than twice as many stops.
 */
function sizeFor(count: number, max: number): number {
  if (max <= 1) return MIN_SIZE;
  return MIN_SIZE + (MAX_SIZE - MIN_SIZE) * Math.sqrt((count - 1) / (max - 1));
}

function sessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function titleOf(bubble: Bubble): string {
  const places = bubble.places.length;
  return places === 1 ? (bubble.places[0]!.label ?? "Unknown location") : `${places} nearby places`;
}

/**
 * The tooltip is built as DOM rather than an HTML string: the label is a
 * geofence name or a reverse-geocoded address, so it is not ours to trust.
 */
function tooltipFor(bubble: Bubble, timezone: string, currency: CurrencyCode): HTMLElement {
  const root = document.createElement("div");
  root.className = "space-y-0.5";

  const name = document.createElement("div");
  name.className = "font-medium";
  name.textContent = titleOf(bubble);
  root.append(name);

  // Kept short: a tooltip taller than the space above its bubble is clipped by
  // the map, which has nowhere else to put it.
  const spent =
    bubble.costCents == null
      ? null
      : bubble.energyKwh
        ? `${cost(bubble.costCents, currency)} · ${rate(bubble.costCents / bubble.energyKwh, currency)} / kWh`
        : cost(bubble.costCents, currency);
  const lines = [
    `${sessions(bubble.count)} · ${u.energy(bubble.energyKwh)}`,
    spent,
    bubble.places.length === 1 ? `Last ${dateOnly(bubble.lastAt, timezone)}` : "Zoom in to separate them",
  ];
  for (const line of lines) {
    if (line === null) continue;
    const row = document.createElement("div");
    row.className = "text-muted-foreground";
    row.textContent = line;
    root.append(row);
  }
  return root;
}

/** Plain-text summary, for the browser tooltip and screen readers. */
function summaryOf(bubble: Bubble): string {
  return `${titleOf(bubble)}: ${sessions(bubble.count)}, ${u.energy(bubble.energyKwh)}`;
}

/**
 * Every place the car has charged, one bubble each, sized and labelled by how
 * many sessions happened there. Leaflet is driven imperatively, as elsewhere in
 * the app, so a change of filters redraws the markers rather than the map.
 */
export function ChargeMap({ points, timezone, currency, className }: ChargeMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  // Both are set by the marker effect below and replayed by the map's own
  // events: what is drawn depends on the zoom it is drawn at.
  const draw = useRef<() => void>(() => {});
  const fitView = useRef<() => void>(() => {});

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);
    map.current = instance;
    layer.current = L.layerGroup().addTo(instance);
    instance.on("zoomend", () => draw.current());

    // The card is laid out after the map is created — and the whole card comes
    // and goes with the filters — so Leaflet measures itself before it has a
    // size worth measuring: tiles fill a strip of the container, and a view
    // fitted to that phantom size lands zoomed in on the middle of nowhere.
    // Both are settled by re-measuring and re-fitting once the size is real.
    const observer = new ResizeObserver(() => {
      instance.invalidateSize();
      fitView.current();
      draw.current();
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const group = layer.current;
    if (!instance || !group) return;

    if (points.length === 0) {
      group.clearLayers();
      draw.current = () => {};
      fitView.current = () => instance.setView([0, 0], 2);
      fitView.current();
      return;
    }

    draw.current = () => {
      group.clearLayers();
      const bubbles = bubblesFor(instance, points);
      const busiest = Math.max(...bubbles.map((b) => b.count));

      for (const bubble of bubbles) {
        const size = sizeFor(bubble.count, busiest);
        const icon = L.divIcon({
          className: "evbook-charge",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          html: `<div class="evb-charge" style="font-size:${size < 34 ? 11 : 13}px">${bubble.count}</div>`,
        });
        L.marker([bubble.latitude, bubble.longitude], {
          icon,
          title: summaryOf(bubble),
          // Small bubbles on top. Leaflet would otherwise stack markers by
          // latitude, which can hide a one-off stop behind a busy place.
          zIndexOffset: -bubble.count * 1000,
        })
          .on("click", (event: L.LeafletMouseEvent) => {
            // Touch devices get no hover, so a tap opens the same tooltip; a
            // tap on a cluster also zooms far enough in to break it up.
            event.target.openTooltip();
            if (bubble.places.length > 1) {
              const spread = L.latLngBounds(bubble.places.map((p) => [p.latitude, p.longitude]));
              instance.fitBounds(spread, { paddingTopLeft: [40, 100], paddingBottomRight: [40, 40], maxZoom: 17 });
            }
          })
          .bindTooltip(tooltipFor(bubble, timezone, currency), { direction: "top", offset: [0, -size / 2] })
          .addTo(group);
      }
    };

    const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]));
    fitView.current = () =>
      instance.fitBounds(bounds, {
        // Extra headroom at the top: a bubble fitted tight against the edge has
        // no room above it for its own tooltip.
        paddingTopLeft: [40, 100],
        paddingBottomRight: [40, 40],
        maxZoom: 15,
      });
    fitView.current();
    draw.current();
  }, [points, timezone, currency]);

  return <div ref={container} className={className} aria-label="Charging locations" />;
}
