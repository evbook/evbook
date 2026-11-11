import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CarDto, ImportJobDto, ImportRecordDto, ImportSourceDto } from "@shared/api-types";
import { fileBundle } from "../../src/core/import/bundle";
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
  /** Direct sources (TeslaMate) match every car by VIN themselves. */
  direct: boolean;
  detection: SourceDetection | null;
  error: string | null;
}

/**
 * One request's worth of upload. A Worker accepts 100 MB per request, and a
 * TeslaMate backup of several years is more than that, so bigger files go in
 * parts the server stitches back together.
 */
const UPLOAD_PART_BYTES = 64 * 1024 * 1024;

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
  const history = useQuery({
    queryKey: ["import-history"],
    queryFn: () => api<ImportRecordDto[]>("/api/v1/imports/history"),
  });
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
  const phase = job.data?.phase;
  useEffect(() => {
    if (phase && !RUNNING.includes(phase)) {
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
    }
    if (phase === "done") {
      queryClient.invalidateQueries({ queryKey: ["cars"] });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["charges"] });
    }
  }, [phase, queryClient]);

  async function pick(file: File | undefined) {
    setFailure(null);
    if (!file) {
      setPreflight(null);
      return;
    }
    try {
      const bundle = await fileBundle(file.name, fileReader(file));
      const best = (await detectSources(bundle))[0];
      const detection = best?.detection ?? null;
      const known = best && (detection?.confidence ?? 0) >= 0.5;
      setPreflight({
        file,
        source: known ? best.source.id : null,
        label: known ? best.source.label : null,
        direct: known ? best.source.mode === "direct" : false,
        detection,
        error: null,
      });
    } catch (error) {
      setPreflight({
        file,
        source: null,
        label: null,
        direct: false,
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
    if (!preflight.direct && !preflight.detection?.vin && carId) params.set("carId", carId);
    if (geocode && !preflight.direct) params.set("geocode", "true");

    try {
      const started = await uploadInParts(params, preflight.file, setUploadPercent);
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

  async function remove(id: number) {
    setFailure(null);
    try {
      // A big import is removed over several requests; each says whether it is done.
      for (;;) {
        const result = await api<{ done: boolean }>(`/api/v1/imports/history/${id}`, { method: "DELETE" });
        if (result.done) break;
      }
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.message ? error.message : "The import could not be deleted.",
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["import-history"] });
    await queryClient.invalidateQueries({ queryKey: ["drives"] });
    await queryClient.invalidateQueries({ queryKey: ["charges"] });
  }

  const needsCar = preflight !== null && preflight.source !== null && !preflight.direct && !preflight.detection?.vin;
  const accept = [...new Set((sources.data ?? []).flatMap((source) => (source.accept ?? "").split(",")))]
    .filter(Boolean)
    .join(",");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import history"
        description="Bring drives and charges logged by another service into EVBook."
        info={
          <InfoTip label="How an import works">
            A Tessie export is replayed through the same logic that records a live drive, so an imported history behaves
            like one EVBook recorded itself. A TeslaMate backup already holds finished drives and charges, so they are
            taken as TeslaMate recorded them — only from before EVBook's own history of the car begins.
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
                accept={accept || ".zip,application/zip"}
                onChange={(e) => void pick(e.target.files?.[0])}
                className="block w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-secondary-foreground"
              />
              {(sources.data ?? [])
                .filter((source) => source.howToExport)
                .map((source) => (
                  <p key={source.id} className="text-xs text-muted-foreground">
                    <span className="font-medium">{source.label}:</span> {source.howToExport}
                  </p>
                ))}
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

            {/* A TeslaMate backup brings its own addresses. */}
            {preflight?.source && !preflight.direct && (
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

      {history.data && history.data.length > 0 && (
        <HistoryCard records={history.data} timezone={timezone} busy={Boolean(running)} onDelete={remove} />
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
        <p className="text-destructive">
          {preflight.file.name} could not be read: {preflight.error}
        </p>
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
              {job.stage ? `Writing ${job.stage}…` : job.at ? `Reached ${dateTime(job.at, timezone)}` : "Starting…"}
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
          <Figure label={job.skipped ? "Rows" : "Samples"} value={number(job.counts.samples, 0)} />
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
            {job.skipped && job.skipped.overlapping + job.skipped.unfinished > 0 && (
              <p className="text-muted-foreground">
                Left out: {number(job.skipped.overlapping, 0)} drive(s) and charge(s) from after EVBook started logging
                the car, and {number(job.skipped.unfinished, 0)} the backup never finished.
              </p>
            )}
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

/** Direct imports on record, each removable with everything it brought. */
function HistoryCard({
  records,
  timezone,
  busy,
  onDelete,
}: {
  records: ImportRecordDto[];
  timezone: string;
  busy: boolean;
  onDelete: (id: number) => Promise<void>;
}) {
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function confirm(id: number) {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported backups</CardTitle>
        <CardDescription>
          Importing the same backup again replaces what it brought. Deleting one removes its drives, charges and
          positions, and leaves everything EVBook logged itself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {records.map((record) => (
            <li key={record.id} data-testid="import-record" className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-medium">
                  {record.carName ?? record.vin} · {record.label ?? record.source}
                </p>
                <p className="text-xs text-muted-foreground">
                  {record.firstAt && record.lastAt
                    ? `${dateOnly(record.firstAt, timezone)} – ${dateOnly(record.lastAt, timezone)} · `
                    : ""}
                  {number(record.drives, 0)} drives, {number(record.chargingProcesses, 0)} charges,{" "}
                  {number(record.positions, 0)} positions
                  {record.skippedOverlapping + record.skippedUnfinished > 0
                    ? ` · ${number(record.skippedOverlapping + record.skippedUnfinished, 0)} left out`
                    : ""}
                  {record.status === "importing" ? " · incomplete" : ""}
                  {record.status === "deleting" ? " · being deleted" : ""}
                </p>
                {record.cutoffAt && (
                  <p className="text-xs text-muted-foreground">
                    Taken up to {dateTime(record.cutoffAt, timezone)}, when EVBook's own history of the car begins.
                  </p>
                )}
              </div>
              {confirmId === record.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deletingId !== null}
                    onClick={() => void confirm(record.id)}
                  >
                    {deletingId === record.id ? "Deleting…" : "Confirm"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={deletingId !== null} onClick={() => setConfirmId(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmId(record.id)}>
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
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
 * Sends the file whole when it fits in one request, and otherwise in parts:
 * the first opens the upload, each further one says where it starts, and the
 * last one starts the import.
 */
async function uploadInParts(
  params: URLSearchParams,
  file: File,
  onProgress: (percent: number) => void,
): Promise<ImportJobDto> {
  if (file.size <= UPLOAD_PART_BYTES) return upload(`/api/v1/imports?${params}`, file, onProgress);

  let started: ImportJobDto | null = null;
  for (let offset = 0; offset < file.size; offset += UPLOAD_PART_BYTES) {
    const part = file.slice(offset, offset + UPLOAD_PART_BYTES);
    const query = new URLSearchParams(params);
    if (offset + UPLOAD_PART_BYTES < file.size) query.set("more", "true");
    const url = offset === 0 ? `/api/v1/imports?${query}` : `/api/v1/imports/current/parts?offset=${offset}&${query}`;
    started = await upload(url, part, (fraction) => onProgress((offset + fraction * part.size) / file.size));
  }
  return started!;
}

/**
 * `fetch` cannot report how much of a body has gone out, and an export is big
 * enough that a user deserves to see it move — so the upload goes through
 * XMLHttpRequest.
 */
function upload(url: string, file: Blob, onProgress: (percent: number) => void): Promise<ImportJobDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", "application/octet-stream");
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
