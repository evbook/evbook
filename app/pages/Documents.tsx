import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CarDto, DocumentCategory, DocumentDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";
import { prepareDocument } from "@/lib/image";
import { dateOnly, number } from "@/lib/format";
import { useAppSettings } from "@/hooks/useAppSettings";
import { useCar } from "@/hooks/useCar";
import { CarSwitcher, carName } from "@/components/CarSwitcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { InfoTip } from "@/components/InfoTip";

/**
 * The glovebox: the paperwork that belongs with each car, kept where the car's
 * history already is. One upload form files a document under a car and a type;
 * below it, each car with paperwork gets its own card. Photos are re-encoded in
 * the browser before they go up (app/lib/image.ts), so a 12 MB phone picture of
 * the logbook arrives as a fraction of that; PDFs go up as they are.
 */

const CATEGORIES: { id: DocumentCategory; title: string; description: string }[] = [
  {
    id: "title",
    title: "Logbook & title",
    description: "The registration document — V5C, title, Fahrzeugbrief — and anything filed with it.",
  },
  {
    id: "inspection",
    title: "MOT & inspection",
    description:
      "The roadworthiness certificate — MOT, TÜV/HU report, contrôle technique, APK, ITV — from the last inspection.",
  },
  {
    id: "tax",
    title: "Road tax & vignette",
    description: "Proof the road is paid for — the vehicle tax receipt, a vignette, a toll or congestion pass.",
  },
  {
    id: "insurance",
    title: "Insurance",
    description: "The current policy, the certificate, the green card — whatever you want at hand.",
  },
];

function categoryTitle(id: DocumentCategory): string {
  return CATEGORIES.find((category) => category.id === id)?.title ?? id;
}

/** The pickers' order, so a car's list reads title → inspection → tax → insurance. */
function categoryRank(id: DocumentCategory): number {
  const rank = CATEGORIES.findIndex((category) => category.id === id);
  return rank === -1 ? CATEGORIES.length : rank;
}

interface Uploading {
  name: string;
  /** null while the image is still being converted, before any bytes move. */
  percent: number | null;
}

export function DocumentsPage() {
  const { car, carId, cars, choose, query: carsQuery } = useCar();
  const documents = useQuery({
    queryKey: ["documents"],
    queryFn: () => api<DocumentDto[]>("/api/v1/documents"),
  });

  const loaded = documents.isSuccess && carsQuery.isSuccess;
  const own = (documents.data ?? []).filter((doc) => car != null && doc.carId === car.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Each car's paperwork, next to its history."
        info={
          <InfoTip label="About documents">
            Photos are compressed in your browser before they upload; nothing here ever leaves your EVBook.
          </InfoTip>
        }
        actions={<CarSwitcher cars={cars} value={carId} onChange={choose} />}
      />

      <UploadCard car={car} />

      {loaded && own.length === 0 && <p className="text-sm text-muted-foreground">Nothing here yet.</p>}

      {car && own.length > 0 && <CarCard car={car} documents={own} />}
    </div>
  );
}

function UploadCard({ car }: { car: CarDto | null }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<DocumentCategory>("title");
  const [uploading, setUploading] = useState<Uploading | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Filed under the car the page is showing; the switcher in the header moves it.
  const carId = car ? String(car.id) : "";
  const chosen = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0]!;

  async function pick(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
    if (!file || !carId) return;
    setFailure(null);
    setUploading({ name: file.name, percent: null });
    try {
      const prepared = await prepareDocument(file);
      const params = new URLSearchParams({ car: carId, category, filename: prepared.name });
      const dto = await upload(`/api/v1/documents?${params}`, prepared, (percent) =>
        setUploading({ name: prepared.name, percent }),
      );
      // The preview rides behind the document; a document without one just
      // shows a placeholder tile, so a failure here is not worth reporting.
      if (prepared.thumbnail) {
        await fetch(`/api/v1/documents/${dto.id}/thumbnail`, {
          method: "POST",
          headers: { "content-type": prepared.thumbnail.contentType },
          body: prepared.thumbnail.blob,
        }).catch(() => undefined);
      }
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.message
          ? error.message
          : error instanceof Error
            ? error.message
            : "The upload failed.",
      );
    } finally {
      setUploading(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a document</CardTitle>
        <CardDescription>
          {car ? <>Filed under {carName(car)}. </> : null}Pick what it is, then choose the file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="doc-type">Type</Label>
            <Select
              id="doc-type"
              className="w-44"
              value={category}
              onChange={(e) => setCategory(e.target.value as DocumentCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{chosen.description}</p>

        {uploading && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {uploading.percent === null
              ? `Preparing ${uploading.name}…`
              : `Uploading ${uploading.name}… ${Math.round(uploading.percent * 100)}%`}
          </p>
        )}

        {failure && <p className="text-sm text-destructive">{failure}</p>}

        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          {/* capture opens the camera app directly on phones; the button only
              shows on coarse-pointer devices, where a camera is worth offering. */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <Button variant="outline" disabled={uploading !== null || !carId} onClick={() => inputRef.current?.click()}>
            Choose a file
          </Button>
          <Button
            variant="outline"
            className="hidden pointer-coarse:inline-flex"
            disabled={uploading !== null || !carId}
            onClick={() => cameraRef.current?.click()}
          >
            Take a photo
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CarCard({ car, documents }: { car: CarDto; documents: DocumentDto[] }) {
  const queryClient = useQueryClient();
  const settings = useAppSettings();
  const timezone = settings.data?.timezone ?? "UTC";
  const [failure, setFailure] = useState<string | null>(null);

  async function remove(doc: DocumentDto) {
    if (!window.confirm(`Delete ${doc.name}? There is no undo.`)) return;
    setFailure(null);
    try {
      await api(`/api/v1/documents/${doc.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
    } catch (error) {
      setFailure(error instanceof ApiRequestError && error.message ? error.message : "The delete failed.");
    }
  }

  const sorted = documents.slice().sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{carName(car)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-border rounded-md border border-border">
          {sorted.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-3 p-3 text-sm">
              <div className="flex min-w-0 items-center gap-3">
                <a
                  href={`/api/v1/documents/${doc.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  {doc.hasThumbnail ? (
                    <img
                      src={`/api/v1/documents/${doc.id}/thumbnail`}
                      alt=""
                      loading="lazy"
                      className="h-12 w-12 rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted text-[10px] font-medium text-muted-foreground">
                      {typeLabel(doc.contentType)}
                    </span>
                  )}
                </a>
                <div className="min-w-0">
                  <a
                    href={`/api/v1/documents/${doc.id}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-medium underline-offset-2 hover:underline"
                  >
                    {doc.name}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {categoryTitle(doc.category)} · {sizeLabel(doc.sizeBytes)} · {typeLabel(doc.contentType)} · added{" "}
                    {dateOnly(doc.createdAt, timezone)}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void remove(doc)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>

        {failure && <p className="text-sm text-destructive">{failure}</p>}
      </CardContent>
    </Card>
  );
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${number(bytes / (1024 * 1024), 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function typeLabel(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  return contentType.replace("image/", "").toUpperCase();
}

/**
 * XMLHttpRequest rather than fetch, for the same reason the history import
 * uses it: fetch cannot report how much of the body has gone out.
 */
function upload(
  url: string,
  prepared: { blob: Blob; contentType: string },
  onProgress: (percent: number) => void,
): Promise<DocumentDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("content-type", prepared.contentType);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        // a non-JSON error body falls through to the generic code below
      }
      if (request.status >= 200 && request.status < 300) resolve(body as DocumentDto);
      else {
        const error = body as { error?: string; message?: string } | null;
        reject(new ApiRequestError(request.status, error?.error ?? `http_${request.status}`, error?.message));
      }
    });
    request.addEventListener("error", () => reject(new Error("the upload failed")));
    request.addEventListener("abort", () => reject(new Error("the upload was cancelled")));
    onProgress(0);
    request.send(prepared.blob);
  });
}
