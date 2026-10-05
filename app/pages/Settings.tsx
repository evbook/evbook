import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import type {
  CarDto,
  CarSettingsDto,
  DataHealthDto,
  GlobalSettingsDto,
  TruncatedSessionDto,
  UpdateRunDto,
  VersionInfoDto,
} from "@shared/api-types";
import { CURRENCY_CODES, currencyLabel, type CurrencyCode } from "@shared/currency";
import { decodeVin, vinDetailRows } from "@shared/vin";
import { api, ApiRequestError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAppSettings, useVersion } from "@/hooks/useAppSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";

/**
 * One setting: what it is, the control, and why you would touch it.
 *
 * Stacked, not label-left-control-right. That row reads well across a whole
 * page, and badly across half of one: a short label and its control end up at
 * opposite ends of a lake of space, and a hint that wraps drags the row's rule
 * down past everything beside it. Stacked, the controls line up down a column,
 * a hint costs the rows next to it nothing, and no rules are needed to tell one
 * setting from the next.
 */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-2 block">
        {label}
      </Label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A setting that is only on or off, with the switch leading the label the way a
 * checkbox does — so a column of them can be read down the left edge, and the
 * label stays next to the thing it names.
 */
function ToggleField({
  label,
  hint,
  id,
  checked,
  onCheckedChange,
  className,
}: {
  label: string;
  hint?: string;
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
        <Label htmlFor={id}>{label}</Label>
      </div>
      {hint && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Settings across the card rather than down it, once there is room for them. */
const FIELD_GRID = "grid gap-x-8 gap-y-6";

const TIMEZONES = (() => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported("timeZone") : [];
  return zones.length > 0 ? zones : ["UTC"];
})();

function GlobalSettingsCard({ settings }: { settings: GlobalSettingsDto }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<GlobalSettingsDto>) =>
      api<GlobalSettingsDto>("/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
      // Efficiency may have been recomputed against the new preferred range.
      queryClient.invalidateQueries({ queryKey: ["cars"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Units and display preferences. Changes save immediately.</CardDescription>
      </CardHeader>
      {/* Six settings: three units, then three preferences — which is the order
          they already came in, so the columns fall out along that seam. */}
      <CardContent className={cn(FIELD_GRID, "sm:grid-cols-2 lg:grid-cols-3")}>
        <Field label="Distance" htmlFor="length">
          <Select
            id="length"
            value={settings.unitOfLength}
            onChange={(e) => save.mutate({ unitOfLength: e.target.value as "km" | "mi" })}
          >
            <option value="km">Kilometres</option>
            <option value="mi">Miles</option>
          </Select>
        </Field>
        <Field label="Temperature" htmlFor="temp">
          <Select
            id="temp"
            value={settings.unitOfTemperature}
            onChange={(e) => save.mutate({ unitOfTemperature: e.target.value as "C" | "F" })}
          >
            <option value="C">Celsius</option>
            <option value="F">Fahrenheit</option>
          </Select>
        </Field>
        <Field label="Tyre pressure" htmlFor="pressure">
          <Select
            id="pressure"
            value={settings.unitOfPressure}
            onChange={(e) => save.mutate({ unitOfPressure: e.target.value as "bar" | "psi" })}
          >
            <option value="bar">bar</option>
            <option value="psi">psi</option>
          </Select>
        </Field>
        <Field
          label="Currency"
          hint="What every cost is shown in, for every car. Amounts are stored as plain numbers, so switching relabels them — nothing is converted."
          htmlFor="currency"
        >
          <Select
            id="currency"
            value={settings.currency}
            onChange={(e) => save.mutate({ currency: e.target.value as CurrencyCode })}
          >
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {currencyLabel(code)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Preferred range"
          hint="Which range figure to show and to derive efficiency from. Changing this recalculates efficiency."
          htmlFor="range"
        >
          <Select
            id="range"
            value={settings.preferredRange}
            onChange={(e) => save.mutate({ preferredRange: e.target.value as "ideal" | "rated" })}
          >
            <option value="rated">Rated</option>
            <option value="ideal">Ideal</option>
          </Select>
        </Field>
        <Field label="Time zone" hint="Used to group statistics into days, weeks and months." htmlFor="tz">
          <Select id="tz" value={settings.timezone} onChange={(e) => save.mutate({ timezone: e.target.value })}>
            {!TIMEZONES.includes(settings.timezone) && <option value={settings.timezone}>{settings.timezone}</option>}
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

/**
 * Light, dark, or following the OS. A card of its own rather than a seventh General
 * field because it is not one of the instance's settings: it is kept in this browser,
 * so a phone in dark mode and a desk monitor in light can each have their way.
 */
function AppearanceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Saved on this device. System follows your operating system's light or dark mode.</CardDescription>
      </CardHeader>
      <CardContent>
        <Field label="Theme">
          <ThemeSwitcher />
        </Field>
      </CardContent>
    </Card>
  );
}

/**
 * The telemetry level, in a card of its own rather than a seventh General
 * field: a privacy choice deserves room to say exactly what each option sends,
 * and "off" deserves to visibly be the default.
 */
function TelemetryCard({ settings }: { settings: GlobalSettingsDto }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<GlobalSettingsDto>) =>
      api<GlobalSettingsDto>("/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (updated) => queryClient.setQueryData(["settings"], updated),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telemetry</CardTitle>
        <CardDescription>
          Anonymous usage reporting to the EVBook project. Off by default; changes save immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className={cn(FIELD_GRID, "sm:grid-cols-2 lg:grid-cols-3")}>
        <Field
          label="Share"
          hint={
            settings.telemetryLevel === "off"
              ? "Nothing is recorded or sent."
              : settings.telemetryLevel === "minimal"
                ? "Installs, updates and critical errors, plus any feedback and survey answers you choose to send."
                : "Minimal, plus a daily anonymous snapshot: model and year, odometer, battery capacity and degradation, firmware, and database row counts."
          }
          htmlFor="telemetry"
        >
          <Select
            id="telemetry"
            value={settings.telemetryLevel}
            onChange={(e) => save.mutate({ telemetryLevel: e.target.value as GlobalSettingsDto["telemetryLevel"] })}
          >
            <option value="off">Off</option>
            <option value="minimal">Minimal — installs, updates, errors</option>
            <option value="extended">Extended — plus vehicle statistics</option>
          </Select>
        </Field>
        <p className="text-xs leading-snug text-muted-foreground sm:col-span-2 lg:self-center">
          Everything is sent by this instance in the background under a random id — never from your browser, and never
          the VIN, your location, names, addresses, or your Tesla account. Turning it off stops everything at once.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * What the VIN says about the car, beside the settings it also decides.
 *
 * Every value is monospaced, not just the VIN: they are all read off the same
 * seventeen characters. They start at one left edge rather than ending at one
 * right edge, because these lines are nothing like the same length — ranged
 * right, each label sat its own distance from its value.
 */
function VehicleDetails({ car, className }: { car: CarDto; className?: string }) {
  // The rated range and sprint rows follow the unit of length: EPA and 0–60 in
  // miles, WLTP and 0–100 in kilometres.
  const settings = useAppSettings();
  const rows = vinDetailRows(decodeVin(car.vin), { unitOfLength: settings.data?.unitOfLength });
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5 text-sm", className)}>
      <dt className="text-muted-foreground">VIN</dt>
      <dd className="font-mono text-xs leading-5">{car.vin}</dd>
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="font-mono text-xs leading-5">{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function CarSettingsCard({ car }: { car: CarDto }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["car-settings", car.id],
    queryFn: () => api<CarSettingsDto>(`/api/v1/cars/${car.id}/settings`),
  });
  const save = useMutation({
    mutationFn: (patch: Partial<CarSettingsDto>) =>
      api<CarSettingsDto>(`/api/v1/cars/${car.id}/settings`, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["car-settings", car.id], updated);
      // "Log this car" rides along on the car itself, and the overview shows only
      // the cars it is on for — so the list has to be refetched, not just this
      // card's copy of the settings.
      void queryClient.invalidateQueries({ queryKey: ["cars"] });
    },
  });

  const title = car.name ?? `VIN …${car.vin.slice(-6)}`;
  const packCandidates = decodeVin(car.vin).packCandidates;

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Sleep settings decide how aggressively EVBook stops polling so the car can rest. The defaults are safe.
        </CardDescription>
      </CardHeader>
      {/*
        The details column is sized to its own longest line rather than to half
        the card, so the settings keep the width they need and a label sits near
        the value it names instead of across a gap from it.
      */}
      <CardContent className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        {/*
          What the VIN says stays first in the source — it is what the card is
          about, and on a phone it should still be read before the switches — but
          on a desktop it moves to the right, where the settings do not need the
          width.
        */}
        <VehicleDetails car={car} className="lg:order-last lg:border-l lg:pl-10" />
        <div className={cn(FIELD_GRID, "sm:grid-cols-2")}>
          {/* The master switch spans the pair below it, because it governs them. */}
          <ToggleField
            label="Log this car"
            hint="Turning this off stops all polling for this vehicle."
            id={`enabled-${car.id}`}
            checked={data.enabled}
            onCheckedChange={(enabled) => save.mutate({ enabled })}
            className="sm:col-span-2"
          />
          <Field
            label="Idle time before sleeping"
            hint="How long the car must be idle before EVBook stops polling."
            htmlFor={`idle-${car.id}`}
          >
            <Select
              id={`idle-${car.id}`}
              value={String(data.suspendAfterIdleMin)}
              onChange={(e) => save.mutate({ suspendAfterIdleMin: Number(e.target.value) })}
            >
              {[3, 5, 10, 15, 20, 25, 30, 45, 60].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Time to try sleeping"
            hint="How long to stay quiet, giving the car a chance to fall asleep."
            htmlFor={`suspend-${car.id}`}
          >
            <Select
              id={`suspend-${car.id}`}
              value={String(data.suspendMin)}
              onChange={(e) => save.mutate({ suspendMin: Number(e.target.value) })}
            >
              {[12, 15, 18, 21, 24, 27, 30, 40, 50, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </Select>
          </Field>
          <ToggleField
            label="Must be locked to sleep"
            hint="Treat an unlocked car as a reason not to stop polling."
            id={`locked-${car.id}`}
            checked={data.reqNotUnlocked}
            onCheckedChange={(reqNotUnlocked) => save.mutate({ reqNotUnlocked })}
          />
          <ToggleField
            label="Free supercharging"
            hint="Bills Tesla-branded charging at zero cost."
            id={`suc-${car.id}`}
            checked={data.freeSupercharging}
            onCheckedChange={(freeSupercharging) => save.mutate({ freeSupercharging })}
          />
          {/* No LFP switch: the pack chemistry is the VIN's to answer (see the
              Battery line in the details), not the owner's. The pack itself is
              different — where the VIN names two, only the owner knows which
              one is in the car, and the answer anchors degradation since new. */}
          {packCandidates && (
            <div className="sm:col-span-2">
              <Field
                label="Battery pack"
                hint="The VIN leaves more than one pack possible. The one the car really has anchors its degradation since new."
                htmlFor={`pack-${car.id}`}
              >
                <Select
                  id={`pack-${car.id}`}
                  value={String(data.usableWhenNewKwh ?? "")}
                  onChange={(e) =>
                    save.mutate({ usableWhenNewKwh: e.target.value === "" ? null : Number(e.target.value) })
                  }
                >
                  <option value="">Not sure — average the possibilities</option>
                  {packCandidates.map((candidate) => (
                    <option key={candidate.pack} value={candidate.usableWhenNewKwh}>
                      {candidate.pack} — ≈ {candidate.usableWhenNewKwh} kWh usable
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ImportHistoryCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import history</CardTitle>
        <CardDescription>
          Bring drives and charges logged by another service into EVBook. The export is replayed through the same
          logic that records a live drive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          to="/import"
          className="inline-flex h-9 items-center rounded-md border bg-card px-4 text-sm font-medium shadow-card transition-colors hover:border-input hover:bg-muted/60"
        >
          Import an export
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * What the CSV export will actually hand over. The route caps a table at this many
 * rows, so a count above it gets a link that says so rather than a file that looks
 * complete — see `/api/v1/export/:table` in `src/api/stats.ts`.
 */
const EXPORT_LIMIT = 100_000;

/** Table names as the rest of the app says them. */
const TABLE_LABELS: Record<string, string> = {
  cars: "Cars",
  drives: "Drives",
  charging_processes: "Charging sessions",
  charges: "Charging samples",
  positions: "Position samples",
  states: "State spans",
  updates: "Firmware updates",
  addresses: "Addresses",
  geofences: "Places",
};

const KIND_LABELS: Record<TruncatedSessionDto["kind"], string> = {
  drive: "Drive",
  charge: "Charge",
  state: "State",
  update: "Update",
};

/**
 * The database talking about itself. Two questions that only get asked when
 * something feels wrong — is it all in here, and is any of it half-written — plus
 * the download that was already implemented and had no way to reach it.
 */
function DataHealthCard() {
  const settings = useAppSettings();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["data-health"],
    queryFn: () => api<DataHealthDto>("/api/v1/data-health"),
    // Counting every position sample is a full scan of the biggest table in the
    // database, so this is read once and kept, not refreshed while you sit here.
    staleTime: 5 * 60_000,
  });
  const timezone = settings.data?.timezone ?? "UTC";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data health</CardTitle>
        <CardDescription>
          What is in the database, and whether any row was left half-written — which a stopped import or a restart
          part-way through a drive can do. Each of these can be downloaded as CSV, so the history is never trapped in
          here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-40" />
        ) : isError || !data ? (
          // Not a skeleton: this query is deliberately never refetched, so a failure
          // left the card as a grey block that would never resolve.
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">Could not read the database.</span>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div>
              {/*
                Not "last heard from the car". This is the newest position sample,
                and a sleeping car writes none — so on a car that has been resting
                for two days it would say the logger last heard from it two days
                ago, which is the wrong answer to the question the card exists for.
              */}
              <p className="text-sm font-medium">
                Last position logged:{" "}
                <span className="font-normal text-muted-foreground">
                  {data.lastSampleAt != null ? dateTime(data.lastSampleAt, timezone) : "never"}
                </span>
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                Across every car, and a resting one records none — so this lags whenever the car has been left alone.
              </p>
              {/* Three columns, because nine tables divide by three and not by two — at
                  two, "Places" sat alone in a final row under a half-width rule. */}
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {data.tables.map((row) => {
                  const label = TABLE_LABELS[row.table] ?? row.table;
                  return (
                    <div key={row.table} className="flex items-baseline justify-between gap-4 border-b py-1">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="flex items-baseline gap-3">
                        <span className="font-medium tabular-nums">{row.rows.toLocaleString()}</span>
                        {/*
                          The accessible name is the whole sentence, not the table
                          name: a link reading "Drives" in the body of a page whose
                          navigation also has a "Drives" is ambiguous to a reader
                          and to a screen reader both.
                        */}
                        <a
                          href={`/api/v1/export/${row.table}.csv`}
                          download
                          aria-label={
                            row.rows > EXPORT_LIMIT
                              ? `Download the first ${EXPORT_LIMIT.toLocaleString()} ${label.toLowerCase()} as CSV`
                              : `Download ${label.toLowerCase()} as CSV`
                          }
                          // Padded out to something a thumb can hit, pulled back in by
                          // the same amount so the row's rhythm does not change.
                          className="-my-1.5 -mr-2 inline-flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Download className="size-3" aria-hidden="true" />
                          {row.rows > EXPORT_LIMIT ? `first ${(EXPORT_LIMIT / 1000).toFixed(0)}k` : "CSV"}
                        </a>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">
                {data.truncatedCount === 0
                  ? "Nothing looks half-written."
                  : `${data.truncatedCount} ${data.truncatedCount === 1 ? "row looks" : "rows look"} half-written.`}
              </p>
              {data.truncatedCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Every drive, charge, state span and firmware update that was started also got an end.
                </p>
              ) : (
                <>
                  <Table label="Rows that were left half-written">
                    <TableHeader>
                      <TableRow>
                        <TableHead>What</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead>Where</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.truncated.map((row) => (
                        <TableRow key={`${row.kind}-${row.id}`}>
                          <TableCell className="font-medium">{KIND_LABELS[row.kind]}</TableCell>
                          <TableCell className="tabular-nums">{dateTime(row.startAt, timezone)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.label ?? "–"}
                            {row.last && " · the last thing logged"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {data.truncatedCount > data.truncated.length &&
                      `Showing the ${data.truncated.length} most recent. `}
                    Nothing is lost: they still show on the History timeline, ending in “now”. The lists and totals
                    leave them out, because an open row has no distance or cost to add.
                  </p>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Something to type, set off from the sentence it sits in. */
function Cmd({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">{children}</code>;
}

/**
 * What is installed, what is available, and what to type to close the gap.
 *
 * The instance does the asking — once a day, from its cron — so this card is a
 * read of what it already knows, plus a button for the moment somebody wants
 * the answer now. It stops at telling you: a logger that can redeploy itself is
 * a much larger thing to trust than a logger, and the two commands below are
 * the whole of what updating one is.
 */
function VersionCard() {
  const settings = useAppSettings();
  const queryClient = useQueryClient();
  const { data } = useVersion();
  const check = useMutation({
    mutationFn: () => api<VersionInfoDto>("/api/v1/version/check", { method: "POST" }),
    onSuccess: (updated) => queryClient.setQueryData(["version"], updated),
  });
  const timezone = settings.data?.timezone ?? "UTC";

  // When this session pressed Install — what separates "the deploy we just
  // started" from whatever old run GitHub lists as the newest.
  const [installedAt, setInstalledAt] = useState<number | null>(null);
  const run = useQuery({
    queryKey: ["update-run"],
    queryFn: () => api<UpdateRunDto | null>("/api/v1/version/update/run"),
    enabled: Boolean(data?.canInstall && data.updateAvailable),
    // Poll while a run is on the way or under way; GitHub takes a few seconds
    // to even list a freshly dispatched one, which is the `!current` case.
    refetchInterval: (query) => {
      const current = query.state.data;
      if (current && current.status !== "completed") return 4000;
      if (installedAt !== null && (!current || current.startedAt < installedAt - 120_000)) return 3000;
      return false;
    },
    // A deploy takes a couple of minutes and people switch tabs while it runs.
    refetchIntervalInBackground: true,
  });
  const install = useMutation({
    mutationFn: () => api("/api/v1/version/update", { method: "POST" }),
    onSuccess: () => {
      setInstalledAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["update-run"] });
    },
  });

  const activeRun = run.data && run.data.status !== "completed" ? run.data : null;
  // Only a completed run this session started gets announced; the newest run
  // being some long-finished deploy from last month is the normal resting state.
  const finishedRun =
    installedAt !== null && run.data && run.data.status === "completed" && run.data.startedAt >= installedAt - 120_000
      ? run.data
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Version</CardTitle>
        <CardDescription>
          Which EVBook this is, and whether there is a newer one. The check is one request a day to the release tags
          on GitHub, made by the server rather than by your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Installed</dt>
          <dd className="font-medium tabular-nums">
            {data ? data.current : <Skeleton className="inline-block h-4 w-16 align-middle" />}
            {data && data.channel !== "stable" && (
              <span className="ml-2 font-normal text-muted-foreground">{data.channel} channel</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Latest</dt>
          <dd>
            {!data ? (
              <Skeleton className="inline-block h-4 w-16 align-middle" />
            ) : data.checkDisabled ? (
              <span className="text-muted-foreground">Update checks are turned off for this instance.</span>
            ) : data.latest === null ? (
              <span className="text-muted-foreground">Not known yet — no check has managed to run.</span>
            ) : (
              <>
                <span className="font-medium tabular-nums">{data.latest}</span>
                {data.releaseUrl && (
                  <a
                    href={data.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-3 text-xs underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  >
                    What’s new
                  </a>
                )}
                {!data.updateAvailable && <span className="ml-3 text-xs text-muted-foreground">up to date</span>}
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="text-muted-foreground">
            {!data ? (
              <Skeleton className="inline-block h-4 w-32 align-middle" />
            ) : data.checkedAt === null ? (
              "never"
            ) : (
              dateTime(data.checkedAt, timezone)
            )}
          </dd>
        </dl>

        {data?.updateAvailable && !data.canInstall && (
          <p className="text-sm leading-7">
            Update by pulling the new build the way you deployed this one — <Cmd>docker compose pull</Cmd> then{" "}
            <Cmd>docker compose up -d</Cmd> on a VPS, <Cmd>git pull</Cmd> then <Cmd>npm run deploy</Cmd> for a
            Cloudflare Worker. Migrations apply themselves at boot, and your logged history is never touched.
          </p>
        )}

        {data?.updateAvailable && data.canInstall && (
          <div className="space-y-2">
            {!activeRun && !finishedRun && (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
                  {install.isPending ? "Starting…" : `Install ${data.latest}`}
                </Button>
                <span className="text-sm text-muted-foreground">
                  Dispatches the deploy workflow on GitHub; this instance keeps running while it builds. Your logged
                  history is never touched.
                </span>
              </div>
            )}
            {install.isError && (
              <p className="text-sm text-destructive">
                {install.error instanceof ApiRequestError && install.error.message
                  ? install.error.message
                  : "The deploy could not be started."}
              </p>
            )}
            {(activeRun || (installedAt !== null && !finishedRun && !install.isError)) && !install.isPending && (
              <p className="text-sm text-muted-foreground">
                Deploying {data.latest}…{" "}
                {activeRun && (
                  <a href={activeRun.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    follow along on GitHub
                  </a>
                )}
              </p>
            )}
            {finishedRun && finishedRun.conclusion === "success" && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm">Deployed. Reload to switch over to {data.latest}.</p>
                <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              </div>
            )}
            {finishedRun && finishedRun.conclusion !== "success" && (
              <p className="text-sm text-destructive">
                The deploy finished with “{finishedRun.conclusion ?? "no conclusion"}” —{" "}
                <a href={finishedRun.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  read the run on GitHub
                </a>
                . This instance is untouched.
              </p>
            )}
          </div>
        )}

        {!data?.checkDisabled && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? "Checking…" : "Check now"}
            </Button>
            {check.isError && <span className="text-sm text-muted-foreground">The check could not be made.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TeslaAccountCard() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api("/api/v1/auth/tesla", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tesla account</CardTitle>
        <CardDescription>
          Disconnecting clears the stored tokens and stops logging until you sign in again. Your history is kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        {confirming ? (
          <>
            <Button variant="destructive" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Yes, disconnect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Disconnect Tesla account
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<GlobalSettingsDto>("/api/v1/settings") });
  const cars = useQuery({ queryKey: ["cars"], queryFn: () => api<CarDto[]>("/api/v1/cars") });

  /*
    Every card's chrome is on screen before its data: the two data-driven cards
    at the top render their headers with sketched controls while they load, and
    the three below them need no request at all — so the page opens at its full
    length instead of growing out of one grey block.
  */
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Units, cars, data and the instance itself." />
      {settings.data ? <GlobalSettingsCard settings={settings.data} /> : <GlobalSettingsCardSkeleton />}
      <AppearanceCard />
      {cars.data ? (
        cars.data.map((car) => <CarSettingsCard key={car.id} car={car} />)
      ) : (
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-40" />
          </CardContent>
        </Card>
      )}
      <ImportHistoryCard />
      <DataHealthCard />
      {settings.data && <TelemetryCard settings={settings.data} />}
      <TeslaAccountCard />
      <VersionCard />
    </div>
  );
}

/** The General card's shape — six labelled selects — while settings load. */
function GlobalSettingsCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Units and display preferences. Changes save immediately.</CardDescription>
      </CardHeader>
      <CardContent className={cn(FIELD_GRID, "sm:grid-cols-2 lg:grid-cols-3")}>
        {Array.from({ length: 6 }, (_, field) => (
          <div key={field}>
            <Skeleton className="mb-2 h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
