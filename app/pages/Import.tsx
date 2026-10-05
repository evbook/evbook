import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CarDto, ImportJobDto, ImportSourceDto } from "@shared/api-types";
import { zipBundle } from "../../src/core/import/bundle";
import { detectSources } from "../../src/core/import/sources";
import type { SourceDetection } from "../../src/core/import/types";
import { api, ApiRequestError } from "@/lib/api";
import { dateOnly, dateTime, number } from "@/lib/format";
import { useAppSettings } from "@/hooks/useAppSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { InfoTip } from "@/components/InfoTip";

/**
 * Bring a history logged elsewhere into EVBook.
 *
 * The export is read twice: once here in the browser, to say what it is and
 * which car it belongs to before anything is uploaded — the adapters are pure,
 * so the same code that does the import can answer that locally — and then on
 * the server, which works through it in the background while this page polls.
 */

interface Preflight {
  file: File;
  source: string | null;
  label: string | null;
  detection: SourceDetection | null;
  error: string | null;
}

/** Random access over a picked file, for the zip reader. */
function fileReader(file: File) {
  return {
    size: file.size,
    read: async (offset: number, length: number) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

const RUNNING: ImportJobDto["phase"][] = ["uploading", "importing"];

export function ImportPage() {
  const queryClient = useQueryClient();
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [carId, setCarId] = useState("");
  const [geocode, setGeocode] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const settings = useAppSettings();
  const timezone = settings.data?.timezone ?? "UTC";
  const sources = useQuery({
    queryKey: ["import-sources"],
    queryFn: () => api<ImportSourceDto[]>("/api/v1/imports/sources"),
  });
  const cars = useQuery({ queryKey: ["cars"], queryFn: () => api<CarDto[]>("/api/v1/cars") });
  const job = useQuery({
    queryKey: ["import-current"],
    queryFn: () => api<ImportJobDto | null>("/api/v1/imports/current"),
    // Poll while there is something to watch; stop as soon as it settles.
    refetchInterval: (query) => (query.state.data && RUNNING.includes(query.state.data.phase) ? 750 : false),
    // An import takes minutes, and people switch tabs. Without this the polling
    // stops the moment the window loses focus and the progress appears stuck.
    refetchIntervalInBackground: true,
  });

  const running = job.data && RUNNING.includes(job.data.phase);
  const uploading = uploadPercent !== null;

  // A finished import changes what every other page shows.
  useEffect(() => {
    if (job.data?.phase === "done") {
      queryClient.invalidateQueries({ queryKey: ["cars"] });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["charges"] });
    }
  }, [job.data?.phase, queryClient]);

  async function pick(file: File | undefined) {
    setFailure(null);
    if (!file) {
      setPreflight(null);
      return;
    }
    try {
      const bundle = zipBundle(file.name, fileReader(file));
      const best = (await detectSources(bundle))[0];
      const detection = best?.detection ?? null;
      setPreflight({
        file,
        source: best && (detection?.confidence ?? 0) >= 0.5 ? best.source.id : null,
        label: best && (detection?.confidence ?? 0) >= 0.5 ? best.source.label : null,
        detection,
        error: null,
      });
    } catch (error) {
      setPreflight({
        file,
        source: null,
        label: null,
        detection: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function start() {
    if (!preflight) return;
    setFailure(null);
    const params = new URLSearchParams({ filename: preflight.file.name });
    if (preflight.source) params.set("source", preflight.source);
    if (!preflight.detection?.vin && carId) params.set("carId", carId);
    if (geocode) params.set("geocode", "true");

    try {
      const started = await upload(`/api/v1/imports?${params}`, preflight.file, setUploadPercent);
      queryClient.setQueryData(["import-current"], started);
      setPreflight(null);
      if (inputRef.current) inputRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: ["import-current"] });
    } catch (error) {
      setFailure(error instanceof ApiRequestError && error.message ? error.message : "The upload failed.");
    } finally {
      setUploadPercent(null);
    }
  }

  async function cancel() {
    await api("/api/v1/imports/current", { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["import-current"] });
  }

  async function resume() {
    setFailure(null);
    try {
      const job = await api<ImportJobDto>("/api/v1/imports/current/resume", { method: "POST" });
      queryClient.setQueryData(["import-current"], job);
    } catch (error) {
      setFailure(error instanceof ApiRequestError && error.message ? error.message : "The import could not resume.");
    }
    await queryClient.invalidateQueries({ queryKey: ["import-current"] });
  }

  async function discard() {
    await api("/api/v1/imports/current?discard=true", { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["import-current"] });
  }

  const needsCar = preflight !== null && preflight.source !== null && !preflight.detection?.vin;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import history"
        description="Bring drives and charges logged by another service into EVBook."
        info={
          <InfoTip label="How an import works">
            The export is replayed through the same logic that records a live drive, so an imported history behaves
            like one EVBook recorded itself.
          </InfoTip>
        }
      />

      {!running && !uploading && (
        <Card>
          <CardHeader>
            <CardTitle>Choose an export</CardTitle>
            <CardDescription>
              {sources.data?.length
                ? sources.data.map((source) => source.describe).join(" · ")
                : "Loading the list of services…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="export">Export file</Label>
              <input
                ref={inputRef}
                id="export"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => void pick(e.target.files?.[0])}
                className="block w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-secondary-foreground"
              />
              {sources.data?.[0]?.howToExport && (
                <p className="text-xs text-muted-foreground">{sources.data[0].howToExport}</p>
              )}
            </div>

            {preflight && <PreflightSummary preflight={preflight} />}

            {needsCar && (
              <div className="space-y-2">
                <Label htmlFor="car">Which car is this?</Label>
                <Select id="car" value={carId} onChange={(e) => setCarId(e.target.value)}>
                  <option value="">
                    {cars.data?.length === 1 ? `${carName(cars.data[0]!)} (the only car)` : "Choose a car"}
                  </option>
                  {(cars.data ?? []).map((car) => (
                    <option key={car.id} value={car.id}>
                      {carName(car)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  The file name carries no VIN, so EVBook cannot tell which car this history belongs to.
                </p>
              </div>
            )}

            {preflight?.source && (
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="geocode">Look up place names while importing</Label>
                  <p className="text-xs text-muted-foreground">
                    Slower — about a second per new place. Left off, drives and charges import without labels and get
                    them filled in gradually in the background.
                  </p>
                </div>
                <Switch id="geocode" checked={geocode} onCheckedChange={setGeocode} />
              </div>
            )}

            {failure && <p className="text-sm text-destructive">{failure}</p>}

            <Button disabled={!preflight?.source} onClick={() => void start()}>
              Start import
            </Button>
          </CardContent>
        </Card>
      )}

      {uploading && <UploadCard percent={uploadPercent} name={preflight?.file.name ?? ""} />}

      {job.data && !uploading && (
        <JobCard
          job={job.data}
          timezone={timezone}
          onCancel={() => void cancel()}
          onResume={() => void resume()}
          onDiscard={() => void discard()}
        />
      )}
    </div>
  );
}

function carName(car: CarDto): string {
  return car.name ?? car.vin;
}

function PreflightSummary({ preflight }: { preflight: Preflight }) {
  if (preflight.error) {
    return (
      <div className="rounded-md border border-destructive/50 p-3 text-sm">
        <p className="text-destructive">{preflight.file.name} could not be read: {preflight.error}</p>
      </div>
    );
  }
  if (!preflight.source) {
    return (
      <div className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
        {preflight.file.name} does not look like an export EVBook knows how to read.
      </div>
    );
  }
  const detection = preflight.detection!;
  return (
    <div className="space-y-1 rounded-md border border-border p-3 text-sm">
      <p>
        <span className="font-medium">{preflight.label}</span> export
        {detection.vin ? (
          <>
            {" "}
            for VIN <span className="font-mono text-xs">{detection.vin}</span>
          </>
        ) : null}
        , {number(preflight.file.size / (1024 * 1024), 1)} MB
      </p>
      <p className="text-xs text-muted-foreground">{detection.recognised.join(", ")}</p>
      {detection.notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

function UploadCard({ percent, name }: { percent: number | null; name: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Uploading {name}</CardTitle>
        <CardDescription>The import starts as soon as the file has arrived.</CardDescription>
      </CardHeader>
      <CardContent>
        <ProgressBar value={percent} />
      </CardContent>
    </Card>
  );
}

function JobCard({
  job,
  timezone,
  onCancel,
  onResume,
  onDiscard,
}: {
  job: ImportJobDto;
  timezone: string;
  onCancel: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const running = RUNNING.includes(job.phase);
  const title =
    job.phase === "done"
      ? "Import finished"
      : job.phase === "failed"
        ? "Import failed"
        : job.phase === "cancelled"
          ? "Import cancelled"
          : `Importing ${job.label}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {job.firstAt && job.lastAt ? (
            <>
              {dateOnly(job.firstAt, timezone)} – {dateOnly(job.lastAt, timezone)}
              {job.vin ? ` · ${job.vin}` : ""}
            </>
          ) : (
            job.label
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {running && (
          <>
            <ProgressBar value={job.progress} />
            <p className="text-sm text-muted-foreground">
              {job.at ? `Reached ${dateTime(job.at, timezone)}` : "Starting…"}
            </p>
          </>
        )}

        {job.phase === "failed" && <p className="text-sm text-destructive">{job.error}</p>}

        {job.resumable && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p>
              Everything up to {job.at ? dateTime(job.at, timezone) : "where it stopped"} is already in the database.
              Resuming carries on from there instead of doing it again.
            </p>
            {job.uploadExpiresAt && (
              <p className="text-xs text-muted-foreground">
                The uploaded file is kept until {dateOnly(job.uploadExpiresAt, timezone)} in case you come back to it.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={onResume}>
                Resume import
              </Button>
              <Button size="sm" variant="outline" onClick={onDiscard}>
                Discard
              </Button>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Samples" value={number(job.counts.samples, 0)} />
          <Figure label="Drives" value={number(job.counts.drives, 0)} />
          <Figure label="Charges" value={number(job.counts.chargingProcesses, 0)} />
          <Figure label="Positions" value={number(job.counts.positions, 0)} />
        </dl>

        {job.phase === "done" && (
          <div className="space-y-2 text-sm">
            <p>
              {number(job.distanceKm, 0)} km driven and {number(job.energyAddedKwh, 0)} kWh charged are now in the
              database.
              {job.replacedRows > 0
                ? ` ${number(job.replacedRows, 0)} row(s) the car already had for this period were replaced.`
                : ""}
            </p>
            <div className="flex gap-2">
              <Link
                to="/drives"
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-button transition-colors hover:bg-primary/90"
              >
                See the drives
              </Link>
              <Link
                to="/stats"
                className="inline-flex h-9 items-center rounded-md border bg-card px-4 text-sm font-medium shadow-card transition-colors hover:border-input hover:bg-muted/60"
              >
                Statistics
              </Link>
            </div>
          </div>
        )}

        {job.warnings.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Best-effort notes ({job.warnings.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {job.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        )}

        {running && (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel import
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function ProgressBar({ value }: { value: number | null }) {
  const percent = value === null ? null : Math.round(value * 100);
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full bg-primary transition-all ${percent === null ? "animate-pulse w-1/3" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{percent === null ? "Working…" : `${percent}%`}</p>
    </div>
  );
}

/**
 * `fetch` cannot report how much of a body has gone out, and an export is big
 * enough that a user deserves to see it move — so the upload goes through
 * XMLHttpRequest.
 */
function upload(url: string, file: File, onProgress: (percent: number) => void): Promise<ImportJobDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", "application/zip");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      const body = parse(request.responseText);
      if (request.status >= 200 && request.status < 300) resolve(body as ImportJobDto);
      else {
        const error = body as { error?: string; message?: string };
        reject(new ApiRequestError(request.status, error?.error ?? `http_${request.status}`, error?.message));
      }
    });
    request.addEventListener("error", () => reject(new Error("the upload failed")));
    request.addEventListener("abort", () => reject(new Error("the upload was cancelled")));
    onProgress(0);
    request.send(file);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
