import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PlaceDto } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";

interface CarMapProps {
  latitude: number;
  longitude: number;
  /** Degrees clockwise from north; renders a direction arrow when present. */
  heading?: number | null;
  zoom?: number;
  className?: string;
  /**
   * Makes the marker answer "where exactly is that": a hover that lingers, or a
   * click, opens a card with the place, the coordinate, and — when the car
   * reports them — its heading and speed.
   */
  details?: { speedKmh?: number | null; units: u.Units };
}

/** How long the pointer rests on the marker before the card opens by itself. */
const HOVER_DELAY_MS = 450;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function compass(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360;
  return `${COMPASS[Math.round(normalised / 45) % 8]} · ${Math.round(normalised)}°`;
}

/**
 * Read-only location map. Leaflet is driven imperatively so position updates
 * pan the existing map rather than remounting it.
 */
export function CarMap({
  latitude,
  longitude,
  heading,
  zoom = 15,
  className,
  details,
}: CarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  // The card's DOM lives inside Leaflet's tooltip; React renders into it.
  const [cardEl] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const interactive = details != null;

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
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);

    // A click anywhere but the marker puts a pinned card away.
    instance.on("click", () => {
      pinned.current = false;
      setOpen(false);
    });

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
      marker.current = L.marker([latitude, longitude], {
        icon,
        keyboard: false,
        interactive,
        title: interactive ? "Show location details" : undefined,
      }).addTo(instance);
    }
    instance.setView([latitude, longitude], instance.getZoom());
    // `interactive` is fixed for the marker's life: a map either has details or not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude, heading]);

  // Hover and click wiring, and the tooltip that holds the card.
  useEffect(() => {
    const m = marker.current;
    if (!interactive || !m || !cardEl) return;
    m.bindTooltip(cardEl, {
      direction: "top",
      offset: [0, -14],
      className: "evb-place-tip",
      // "Permanent" only in that Leaflet adds no hover handling of its own: the
      // card is opened and closed from here, so a pinned one stays put and an
      // unpinned one waits out the delay.
      permanent: true,
    });
    m.closeTooltip();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const enter = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
    };
    const leave = () => {
      clearTimeout(timer);
      if (!pinned.current) setOpen(false);
    };
    const click = (event: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(event);
      clearTimeout(timer);
      pinned.current = !pinned.current || !m.isTooltipOpen();
      setOpen(pinned.current);
    };
    m.on("mouseover", enter).on("mouseout", leave).on("click", click);
    return () => {
      clearTimeout(timer);
      m.off("mouseover", enter).off("mouseout", leave).off("click", click);
      m.unbindTooltip();
    };
  }, [interactive, cardEl]);

  useEffect(() => {
    const m = marker.current;
    if (!m || !interactive) return;
    if (open) m.openTooltip();
    else m.closeTooltip();
  }, [open, interactive]);

  // Leaflet centres a tooltip on the width it had when it opened; the address
  // arrives a moment later, so re-anchor whenever the card changes size.
  useEffect(() => {
    if (!cardEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      marker.current?.getTooltip()?.update(),
    );
    observer.observe(cardEl);
    return () => observer.disconnect();
  }, [cardEl]);

  return (
    <>
      <div
        ref={container}
        className={className}
        aria-label="Vehicle location"
      />
      {interactive &&
        cardEl &&
        open &&
        createPortal(
          <PlaceCard
            latitude={latitude}
            longitude={longitude}
            heading={heading}
            speedKmh={details.speedKmh}
            units={details.units}
          />,
          cardEl,
        )}
    </>
  );
}

/** Rounded to about ten metres: enough to name a place, few enough to cache. */
const round = (value: number) => Math.round(value * 1e4) / 1e4;

function PlaceCard({
  latitude,
  longitude,
  heading,
  speedKmh,
  units,
}: {
  latitude: number;
  longitude: number;
  heading?: number | null;
  speedKmh?: number | null;
  units: u.Units;
}) {
  const lat = round(latitude);
  const lon = round(longitude);
  const place = useQuery({
    queryKey: ["place", lat, lon],
    queryFn: () => api<PlaceDto>(`/api/v1/place?lat=${lat}&lon=${lon}`),
    staleTime: Infinity,
    retry: false,
  });

  const moving = speedKmh != null && speedKmh > 0;
  const label = place.data?.label ?? null;
  const region = place.data?.region ?? null;

  return (
    <div className="w-max max-w-64 space-y-1.5 whitespace-normal">
      <div className="min-h-5">
        {place.isPending ? (
          <span className="text-muted-foreground">Looking up the address…</span>
        ) : label || region ? (
          <>
            <div className="font-medium leading-snug">{label ?? region}</div>
            {label && region && (
              <div className="text-muted-foreground">{region}</div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            No address for this spot
          </span>
        )}
      </div>
      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {latitude.toFixed(5)}, {longitude.toFixed(5)}
      </div>
      {(typeof heading === "number" || moving) && (
        <div className="flex gap-3 border-t border-border pt-1.5 text-muted-foreground">
          {typeof heading === "number" && (
            <span>Heading {compass(heading)}</span>
          )}
          {moving && (
            <span className="text-foreground">{u.speed(speedKmh, units)}</span>
          )}
        </div>
      )}
    </div>
  );
}
