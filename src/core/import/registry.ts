import type { ImportBundle, ImportSourceAdapter, SourceDetection } from "./types";

/**
 * The adapter registry. Adding a vendor is one file plus one `registerSource`
 * call — nothing else in the pipeline changes, and the CLI picks it up in
 * `--list-sources` and in auto-detection.
 */

const sources = new Map<string, ImportSourceAdapter>();

export function registerSource(source: ImportSourceAdapter): void {
  sources.set(source.id, source);
}

export function listSources(): ImportSourceAdapter[] {
  return [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getSource(id: string): ImportSourceAdapter | null {
  return sources.get(id) ?? null;
}

export interface DetectedSource {
  source: ImportSourceAdapter;
  detection: SourceDetection;
}

/**
 * Asks every registered adapter what it makes of the bundle and returns them
 * best-first. A caller wanting "the" answer takes the head and checks its
 * confidence.
 */
export async function detectSources(bundle: ImportBundle): Promise<DetectedSource[]> {
  const results: DetectedSource[] = [];
  for (const source of listSources()) {
    try {
      const detection = await source.detect(bundle);
      if (detection.confidence > 0) results.push({ source, detection });
    } catch (error) {
      // A malformed bundle must not stop the other adapters from having a look.
      results.push({
        source,
        detection: {
          confidence: 0,
          vin: null,
          recognised: [],
          missing: [],
          notes: [`detection failed: ${error instanceof Error ? error.message : String(error)}`],
        },
      });
    }
  }
  return results.sort((a, b) => b.detection.confidence - a.detection.confidence);
}
