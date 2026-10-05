import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeofenceDto } from "@shared/api-types";

interface GeofenceOverviewMapProps {
  geofences: GeofenceDto[];
  /** A pin was clicked. The page decides what that means — here, the edit form. */
  onSelect: (id: number) => void;
  className?: string;
}

/**
 * Every geo-fence on one map: a pin at each centre with its circle drawn at
 * true radius, fitted so all of them are in view. Read-only — the editable
 * single-fence map is `GeofenceMap`. Leaflet is driven imperatively, as
 * elsewhere in the app, so a change of fences redraws the markers, not the map.
 */
export function GeofenceOverviewMap({ geofences, onSelect, className }: GeofenceOverviewMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitView = useRef<() => void>(() => {});
  // Kept fresh without re-binding marker handlers on every render; written in an
  // effect, not during render, for the same StrictMode reason as GeofenceMap.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);
    map.current = instance;
    layer.current = L.layerGroup().addTo(instance);

    // The card is laid out after the map is created, so Leaflet measures itself
    // before it has a size worth measuring; re-measure and re-fit once it does.
    const observer = new ResizeObserver(() => {
      instance.invalidateSize();
      fitView.current();
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

    group.clearLayers();
    if (geofences.length === 0) {
      fitView.current = () => instance.setView([0, 0], 2);
      fitView.current();
      return;
    }

    // A CSS pin avoids bundling Leaflet's default marker images, which resolve
    // to broken relative URLs under a bundler.
    const icon = L.divIcon({
      className: "evbook-pin evbook-pin-static",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      html: '<div class="evb-pin"></div>',
    });

    // The circles' bounds, not the centres': a fence's whole radius stays in
    // view. Computed with toBounds rather than circle.getBounds(), which would
    // project through a zoom this map does not have until these very bounds
    // give it its first view.
    const bounds = L.latLngBounds([]);
    for (const fence of geofences) {
      L.circle([fence.latitude, fence.longitude], {
        radius: fence.radius,
        color: "#3b5bdb",
        weight: 2,
        fillOpacity: 0.15,
      }).addTo(group);
      L.marker([fence.latitude, fence.longitude], { icon, title: fence.name })
        .on("click", () => onSelectRef.current(fence.id))
        .bindTooltip(fence.name, { direction: "top", offset: [0, -12] })
        .addTo(group);
      bounds.extend(L.latLng(fence.latitude, fence.longitude).toBounds(fence.radius * 2));
    }

    fitView.current = () => instance.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    fitView.current();
  }, [geofences]);

  return <div ref={container} className={className} aria-label="Geo-fence locations" />;
}
