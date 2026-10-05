import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface CarMapProps {
  latitude: number;
  longitude: number;
  /** Degrees clockwise from north; renders a direction arrow when present. */
  heading?: number | null;
  zoom?: number;
  className?: string;
}

/**
 * Read-only location map. Leaflet is driven imperatively so position updates
 * pan the existing map rather than remounting it.
 */
export function CarMap({ latitude, longitude, heading, zoom = 15, className }: CarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, {
      zoomControl: false,
      // Credited along the top: the bottom edge fades into the card on a phone,
      // and the card's own heading overlaps it there.
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      touchZoom: false,
    }).setView([latitude, longitude], zoom);
    L.control.attribution({ position: "topright" }).addTo(instance);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      marker.current = null;
    };
    // Initial view only; later changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const icon = L.divIcon({
      className: "evbook-marker",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      html:
        typeof heading === "number"
          ? `<div class="evb-dot"><svg viewBox="0 0 24 24" style="transform: rotate(${heading}deg)">` +
            `<path d="M12 3 L18 20 L12 16 L6 20 Z" fill="white"/></svg></div>`
          : `<div class="evb-dot"></div>`,
    });

    if (marker.current) {
      marker.current.setLatLng([latitude, longitude]);
      marker.current.setIcon(icon);
    } else {
      marker.current = L.marker([latitude, longitude], { icon, keyboard: false }).addTo(instance);
    }
    instance.setView([latitude, longitude], instance.getZoom());
  }, [latitude, longitude, heading]);

  return <div ref={container} className={className} aria-label="Vehicle location" />;
}
