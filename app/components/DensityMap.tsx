import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { countDrives, heatImage, peakOf, projectTracks, tracksBounds, type DensityTrack } from "@/lib/density";

interface DensityMapProps {
  /** One encoded polyline per drive, as `/drives/density` sends them. */
  tracks: string[];
  className?: string;
}

const TILE = 256;

/**
 * Half the width of a road, in CSS pixels, before the glow. Also what each tile
 * is drawn oversized by, so the glow of a road just over its edge is in it.
 */
const ROAD = 1;

/**
 * The heat, as tiles Leaflet asks for like any other layer — so panning, the zoom
 * animation and which tiles to keep are its business, and all that is left here
 * is to count the drives through one square of the world and colour it.
 */
class DensityLayer extends L.GridLayer {
  private readonly tracks: DensityTrack[];
  private readonly peak: number;

  constructor(tracks: DensityTrack[], peak: number, options: L.GridLayerOptions) {
    super(options);
    this.tracks = tracks;
    this.peak = peak;
  }

  protected override createTile(coords: L.Coords): HTMLElement {
    const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    const size = TILE * ratio;
    const radius = ROAD * ratio;
    // Widening and softening each reach `radius`, once per axis.
    const margin = radius * 2 + 1;
    const width = size + margin * 2;

    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;

    const counts = countDrives(this.tracks, {
      scale: TILE * ratio * 2 ** coords.z,
      left: coords.x * size - margin,
      top: coords.y * size - margin,
      width,
      height: width,
    });
    // Most of the world has no drive through it; an empty tile skips the rest.
    if (peakOf(counts) === 0) return tile;

    const context = tile.getContext("2d");
    if (!context) return tile;
    const pixels = heatImage(counts, width, width, this.peak, radius);
    const image = context.createImageData(width, width);
    image.data.set(pixels);
    context.putImageData(image, -margin, -margin);
    return tile;
  }
}

/**
 * Where a selection of drives went, and how often: every drive's track laid over
 * the others, brighter where more of them share the road.
 */
export function DensityMap({ tracks, className }: DensityMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.GridLayer | null>(null);
  const projected = useMemo(() => projectTracks(tracks), [tracks]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: true, scrollWheelZoom: false, maxZoom: 17 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    layer.current?.remove();
    layer.current = null;

    const bounds = tracksBounds(projected);
    if (!bounds) {
      instance.setView([0, 0], 2);
      return;
    }
    instance.fitBounds(
      [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ],
      { padding: [24, 24], animate: false },
    );

    /*
      The top of the scale is the busiest pixel of the whole selection at the zoom
      it opens on, and stays that as the map is moved: a scale worked out again
      for each view would turn a side street white the moment the main road left
      the frame. Zoomed in, the same road counts the same drives, so it holds.
    */
    const zoom = instance.getZoom();
    const scale = TILE * 2 ** zoom;
    const size = instance.getSize();
    const origin = instance.getPixelBounds().min;
    if (!origin) return;
    const peak = peakOf(
      countDrives(projected, {
        scale,
        left: Math.floor(origin.x),
        top: Math.floor(origin.y),
        width: Math.max(1, Math.ceil(size.x)),
        height: Math.max(1, Math.ceil(size.y)),
      }),
    );

    // Not the tile pane: that one is recoloured as a whole (index.css), and the
    // heat has to keep its own colours.
    layer.current = new DensityLayer(projected, peak, { pane: "overlayPane", tileSize: TILE }).addTo(instance);
  }, [projected]);

  return (
    <div
      ref={container}
      className={["evb-density-map", className].filter(Boolean).join(" ")}
      aria-label="Route density"
    />
  );
}
