import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface GeofenceMapProps {
  latitude: number;
  longitude: number;
  radius: number;
  onMove: (latitude: number, longitude: number) => void;
  className?: string;
}

/**
 * Editable geofence map: drag the pin (or click the map) to move the centre,
 * and the circle tracks the radius from the form.
 */
export function GeofenceMap({ latitude, longitude, radius, onMove, className }: GeofenceMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const circle = useRef<L.Circle | null>(null);
  // Keep the latest callback without re-binding map handlers on every render.
  // Written in an effect, not during render: a render that mutates a ref is not
  // idempotent, so it misbehaves as soon as React renders twice and throws one
  // away — which it does in StrictMode and may do at will when interrupting.
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current).setView([latitude, longitude], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);

    // A CSS pin avoids bundling Leaflet's default marker images, which resolve
    // to broken relative URLs under a bundler.
    const icon = L.divIcon({
      className: "evbook-pin",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      html: '<div class="evb-pin"></div>',
    });
    const pin = L.marker([latitude, longitude], { draggable: true, icon }).addTo(instance);
    pin.on("dragend", () => {
      const { lat, lng } = pin.getLatLng();
      onMoveRef.current(Number(lat.toFixed(6)), Number(lng.toFixed(6)));
    });
    instance.on("click", (event: L.LeafletMouseEvent) => {
      onMoveRef.current(Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6)));
    });

    map.current = instance;
    marker.current = pin;
    circle.current = L.circle([latitude, longitude], {
      radius,
      color: "#3b5bdb",
      weight: 2,
      fillOpacity: 0.15,
    }).addTo(instance);

    return () => {
      instance.remove();
      map.current = null;
      marker.current = null;
      circle.current = null;
    };
    // Set up once; subsequent prop changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    marker.current?.setLatLng([latitude, longitude]);
    circle.current?.setLatLng([latitude, longitude]);
    circle.current?.setRadius(radius);
  }, [latitude, longitude, radius]);

  return <div ref={container} className={className} aria-label="Geofence location" />;
}
