import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateRunDto, VersionInfoDto } from "@shared/api-types";
import { APP_VERSION } from "@shared/version";
import { api, ApiRequestError } from "@/lib/api";
import { useVersion } from "@/hooks/useAppSettings";

/**
 * Where an update stands, for the Settings card and the dialog it opens.
 *
 *  - `offer`      a newer release is known and nothing has been started;
 *  - `deploying`  this session started the deploy workflow and it has not finished;
 *  - `failed`     that run finished some other way than well;
 *  - `landed`     the server now answering is a different build from this page.
 *
 * `landed` is read off the server rather than off the workflow run: it is true
 * however the new build got there — the Install button, or somebody typing the
 * deploy at a terminal while the dialog recited the steps — and it is the only
 * one of these a by-hand update can ever reach.
 */
export type UpdatePhase = "idle" | "offer" | "deploying" | "failed" | "landed";

/** How far around "now" a run may have started and still be the one just asked for. */
const DISPATCH_SLACK_MS = 120_000;

export interface UpdateFlow {
  info: VersionInfoDto | undefined;
  phase: UpdatePhase;
  /** The workflow run being followed, once GitHub lists it. */
  run: UpdateRunDto | null;
  /** Dispatches the deploy workflow. Only meaningful when `info.canInstall`. */
  start: () => void;
  starting: boolean;
  /** Why the deploy could not be started, in words fit to show. */
  startError: string | null;
  /** Back to `offer` after a failure, to try once more. */
  reset: () => void;
}

/**
 * `watching` is the dialog being open on its by-hand steps: the page then asks
 * the server which build it is every few seconds, so that it can say "it's
 * live" the moment the deploy typed in a terminal lands.
 */
export function useUpdateFlow({ watching }: { watching: boolean }): UpdateFlow {
  const queryClient = useQueryClient();
  // When this session pressed Install — what separates "the deploy we just
  // started" from whatever old run GitHub lists as the newest.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const { data: info } = useVersion({ watch: watching || startedAt !== null });
  const landed = info !== undefined && info.current !== APP_VERSION;

  const runQuery = useQuery({
    queryKey: ["update-run"],
    queryFn: () => api<UpdateRunDto | null>("/api/v1/version/update/run"),
    enabled: Boolean(info?.canInstall && info.updateAvailable),
    // Poll while a run is on the way or under way; GitHub takes a few seconds
    // to even list a freshly dispatched one, which is the `!current` case.
    refetchInterval: (query) => {
      const current = query.state.data;
      if (current && current.status !== "completed") return 4000;
      if (startedAt !== null && (!current || current.startedAt < startedAt - DISPATCH_SLACK_MS)) return 3000;
      return false;
    },
    // A deploy takes a couple of minutes and people switch tabs while it runs.
    refetchIntervalInBackground: true,
  });
  const dispatch = useMutation({
    mutationFn: () => api("/api/v1/version/update", { method: "POST" }),
    onSuccess: () => {
      setStartedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["update-run"] });
    },
  });

  // Only a run this session started counts; the newest run being some
  // long-finished deploy from last month is the normal resting state.
  const ours =
    startedAt !== null && runQuery.data && runQuery.data.startedAt >= startedAt - DISPATCH_SLACK_MS
      ? runQuery.data
      : null;
  // A run somebody else started — another tab, the Actions page — is still a
  // deploy under way, and worth saying so rather than offering a second one.
  const active = runQuery.data && runQuery.data.status !== "completed" ? runQuery.data : null;
  const finished = ours && ours.status === "completed" ? ours : null;

  let phase: UpdatePhase = "idle";
  if (landed || finished?.conclusion === "success") phase = "landed";
  else if (finished) phase = "failed";
  else if (active || startedAt !== null) phase = "deploying";
  else if (info?.updateAvailable) phase = "offer";

  return {
    info,
    phase,
    run: finished ?? active,
    start: () => dispatch.mutate(),
    starting: dispatch.isPending,
    startError: dispatch.isError
      ? dispatch.error instanceof ApiRequestError && dispatch.error.message
        ? dispatch.error.message
        : "The deploy could not be started."
      : null,
    reset: () => {
      setStartedAt(null);
      dispatch.reset();
    },
  };
}
