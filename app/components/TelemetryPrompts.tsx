import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import type { SurveyResponseDto, SurveyStateDto } from "@shared/api-types";
import type { SurveyConfig, SurveyQuestion } from "@shared/telemetry";
import { api } from "@/lib/api";
import { createErrorGate, describeThrown, surveyShowAt, type ErrorReport } from "@/lib/telemetryPrompts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/**
 * The two prompts telemetry brings with it, both mounted once in the Shell and
 * both silent unless telemetry is on: a toast when the page itself crashes
 * (the report has already been queued server-side by then — the toast only
 * asks whether the person wants to add words to it), and the post-update
 * survey the server offered, shown at the moment lib/telemetryPrompts.ts drew
 * for this browser and settled server-side so it never comes back.
 */
export function TelemetryPrompts({ enabled }: { enabled: boolean }) {
  // Unmounted entirely while off: no listeners, no survey request, nothing.
  return enabled ? <ActivePrompts /> : null;
}

const TEXTAREA =
  "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ActivePrompts() {
  return (
    <>
      <CrashPrompt />
      <SurveyPrompt />
    </>
  );
}

function CrashPrompt() {
  const [crash, setCrash] = useState<ErrorReport | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    // Per-mount, which is per-session in practice: the Shell mounts once.
    const gate = createErrorGate();
    function report(detail: ErrorReport) {
      if (!gate(detail.message)) return;
      // Queued server-side whatever happens to the toast; the level is
      // re-checked there, so a stale tab cannot over-share.
      void api("/api/v1/telemetry/error", { method: "POST", body: JSON.stringify(detail) }).catch(() => {});
      setCrash((current) => current ?? detail);
    }
    const onError = (event: ErrorEvent) =>
      report(describeThrown(event.error ?? event.message, "Script error", window.location.pathname));
    const onRejection = (event: PromiseRejectionEvent) =>
      report(describeThrown(event.reason, "Unhandled rejection", window.location.pathname));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const send = useMutation({
    mutationFn: () =>
      api<undefined>("/api/v1/telemetry/feedback", {
        method: "POST",
        body: JSON.stringify({ message, context: `error-toast: ${crash?.message.slice(0, 200) ?? ""}` }),
      }),
    onSuccess: () => {
      setWriting(false);
      setDismissed(true);
    },
  });

  if (!crash || dismissed) return null;

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm rounded-xl border bg-popover p-4 shadow-overlay sm:inset-x-auto sm:left-auto sm:right-6"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Something went wrong</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              An anonymous crash report was queued. A line about what you were doing makes it much easier to fix.
            </p>
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => setWriting(true)}>
                Add details
              </Button>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Dismiss the error notice"
            className="-mr-2 -mt-2 size-8 shrink-0 p-0"
            onClick={() => setDismissed(true)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Dialog open={writing} onClose={() => setWriting(false)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (message.trim()) send.mutate();
          }}
        >
          <p className="text-sm font-medium">What were you doing when it broke?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent with the crash report, nothing else attached.
          </p>
          <textarea
            className={`${TEXTAREA} mt-3`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={4000}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setWriting(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!message.trim() || send.isPending}>
              Send
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function SurveyPrompt() {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["telemetry-survey"],
    queryFn: () => api<SurveyStateDto>("/api/v1/telemetry/survey"),
    // The answer changes on updates and on answering, not during a session.
    staleTime: 24 * 60 * 60_000,
  });
  const survey = state.data?.survey ?? null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!survey) return;
    // The random moment this browser drew for the survey, held across loads.
    const showAt = surveyShowAt(window.localStorage, survey, Date.now(), Math.random());
    // Due now opens on a zero-delay timer, and a moment mid-session fires when
    // it comes — capped below setTimeout's 32-bit ceiling, past which the
    // survey simply waits for a later load.
    const delay = Math.max(0, showAt - Date.now());
    if (delay >= 2 ** 31) return;
    const timer = setTimeout(() => setOpen(true), delay);
    return () => clearTimeout(timer);
  }, [survey]);

  const respond = useMutation({
    mutationFn: (response: SurveyResponseDto) =>
      api<undefined>("/api/v1/telemetry/survey", { method: "POST", body: JSON.stringify(response) }),
    onSuccess: () => {
      // Settled server-side; this browser stops asking too.
      queryClient.setQueryData<SurveyStateDto>(["telemetry-survey"], { survey: null });
      setOpen(false);
    },
  });

  if (!survey || !open) return null;
  return <SurveyDialog survey={survey} respond={(response) => respond.mutate(response)} pending={respond.isPending} />;
}

function SurveyDialog({
  survey,
  respond,
  pending,
}: {
  survey: SurveyConfig;
  respond: (response: SurveyResponseDto) => void;
  pending: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  // The dialog's close event fires for Escape as well as the buttons; a survey
  // waved away in any manner is dismissed for good, so it must settle exactly once.
  const settled = useRef(false);

  function settle(response: SurveyResponseDto) {
    if (settled.current) return;
    settled.current = true;
    respond(response);
  }

  function answer(id: string, value: string | number) {
    setAnswers((current) => ({ ...current, [id]: value }));
  }

  // A text box focused and left empty is not an answer.
  const given = Object.fromEntries(
    Object.entries(answers).filter(([, value]) => typeof value === "number" || value.trim() !== ""),
  );

  return (
    <Dialog
      open
      onClose={() => settle({ surveyId: survey.id, status: "dismissed" })}
      className="max-w-md"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          settle({ surveyId: survey.id, status: "answered", answers: given });
        }}
      >
        <p className="text-sm font-medium">{survey.title}</p>
        {survey.description && <p className="mt-1 text-xs text-muted-foreground">{survey.description}</p>}
        <div className="mt-4 space-y-5">
          {survey.questions.map((question) => (
            <Question key={question.id} question={question} value={answers[question.id]} onAnswer={answer} />
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => settle({ surveyId: survey.id, status: "dismissed" })}
          >
            No thanks
          </Button>
          <Button type="submit" size="sm" disabled={pending || Object.keys(given).length === 0}>
            Send
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Question({
  question,
  value,
  onAnswer,
}: {
  question: SurveyQuestion;
  value: string | number | undefined;
  onAnswer: (id: string, value: string | number) => void;
}) {
  const inputId = `survey-${question.id}`;
  if (question.type === "scale") {
    const min = question.min ?? 1;
    const max = question.max ?? 5;
    const steps = Array.from({ length: max - min + 1 }, (_, index) => min + index);
    return (
      <div>
        <Label className="mb-2 block">{question.label}</Label>
        <div className="flex flex-wrap gap-1.5">
          {steps.map((step) => (
            <Button
              key={step}
              type="button"
              size="sm"
              variant={value === step ? "default" : "outline"}
              className="size-9 p-0"
              aria-pressed={value === step}
              onClick={() => onAnswer(question.id, step)}
            >
              {step}
            </Button>
          ))}
        </div>
        {(question.minLabel || question.maxLabel) && (
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{question.minLabel}</span>
            <span>{question.maxLabel}</span>
          </div>
        )}
      </div>
    );
  }
  if (question.type === "select") {
    return (
      <div>
        <Label htmlFor={inputId} className="mb-2 block">
          {question.label}
        </Label>
        <Select
          id={inputId}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onAnswer(question.id, event.target.value)}
        >
          <option value="" disabled>
            Choose…
          </option>
          {(question.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  return (
    <div>
      <Label htmlFor={inputId} className="mb-2 block">
        {question.label}
      </Label>
      <textarea
        id={inputId}
        className={TEXTAREA}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onAnswer(question.id, event.target.value)}
        maxLength={2000}
      />
    </div>
  );
}
