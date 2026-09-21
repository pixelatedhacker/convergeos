import {
  CommandId,
  PageId,
  PAGE_MAX_TITLE_LENGTH,
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type Page,
  type PageContentInput,
  type ProjectId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function ProjectPages({
  environmentId,
  projectId,
  environmentLabel,
  maxDocumentBytes,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environmentLabel: string;
  readonly maxDocumentBytes: number;
}) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const query = useEnvironmentQuery(
    orchestrationEnvironment.pages({
      environmentId,
      input: { projectId, includeArchived, limit: 200 },
    }),
  );
  const [selected, setSelected] = useState<Page | null>(null);
  const [creating, setCreating] = useState(false);
  const update = useAtomCommand(orchestrationEnvironment.updatePage, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (command: ClientOrchestrationCommand) => {
    setBusy(true);
    setError(null);
    try {
      const result = await update({ environmentId, input: command });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setSelected(null);
      setCreating(false);
      query.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the page.");
      query.refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">Pages · {environmentLabel}</h2>
        <Button size="xs" variant="ghost" onClick={query.refresh}>
          Refresh
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
        >
          Save a page
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Saved reports, websites, and tools. Open them from any device connected to this environment.
      </p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
        Show archived
      </label>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="text-sm text-muted-foreground">Loading pages…</p>
      ) : null}
      {query.data?.pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved pages.</p>
      ) : null}
      {query.data?.pages.map((page) => (
        <button
          key={page.id}
          type="button"
          className="flex items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted"
          onClick={() => {
            setError(null);
            setSelected(page);
          }}
        >
          <span className="min-w-0 flex-1 truncate text-sm">{page.title}</span>
          <span className="text-xs text-muted-foreground">
            {page.archivedAt ? "Archived" : `Version ${page.currentRevision}`}
          </span>
        </button>
      ))}
      {query.data?.pages.length === 200 ? (
        <p className="text-xs text-muted-foreground">
          Showing the 200 most recently updated pages.
        </p>
      ) : null}
      {creating || selected ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) {
              setCreating(false);
              setSelected(null);
            }
          }}
        >
          <DialogPopup className="w-full sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{selected?.title ?? "Save a page"}</DialogTitle>
              <DialogDescription>
                {selected
                  ? `Saved ${new Date(selected.updatedAt).toLocaleString()}. ${selected.kind === "htmlDocument" ? "Document stored on this environment." : "Link to an external website."}`
                  : "Upload an HTML document or save an HTTPS link."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {error ? (
                <p role="alert" className="mb-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {selected ? (
                <SavedPage
                  environmentId={environmentId}
                  page={selected}
                  busy={busy}
                  maxDocumentBytes={maxDocumentBytes}
                  run={run}
                />
              ) : (
                <PageSaveForm
                  maxDocumentBytes={maxDocumentBytes}
                  busy={busy}
                  onSave={(title, content) =>
                    run({
                      type: "page.create",
                      commandId: CommandId.make(randomUUID()),
                      pageId: PageId.make(randomUUID()),
                      projectId,
                      title,
                      sourceThreadId: null,
                      content,
                      dataAt: null,
                      createdAt: new Date().toISOString(),
                    })
                  }
                />
              )}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </section>
  );
}

function SavedPage({
  environmentId,
  page,
  busy,
  maxDocumentBytes,
  run,
}: {
  readonly environmentId: EnvironmentId;
  readonly page: Page;
  readonly busy: boolean;
  readonly maxDocumentBytes: number;
  readonly run: (command: ClientOrchestrationCommand) => Promise<boolean>;
}) {
  const content = useEnvironmentQuery(
    orchestrationEnvironment.pageContent({ environmentId, input: { pageId: page.id } }),
  );
  const navigate = useNavigate();
  const [title, setTitle] = useState(page.title);
  const metadata = () => ({
    commandId: CommandId.make(randomUUID()),
    pageId: page.id,
    expectedMetadataRevision: page.metadataRevision,
    createdAt: new Date().toISOString(),
  });
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run({ ...metadata(), type: "page.rename", title: title.trim() });
        }}
      >
        <Input
          aria-label="Page title"
          value={title}
          maxLength={PAGE_MAX_TITLE_LENGTH}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={
            busy || page.archivedAt !== null || !title.trim() || title.trim() === page.title
          }
        >
          Rename
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run({ ...metadata(), type: page.archivedAt ? "page.restore" : "page.archive" })
          }
        >
          {page.archivedAt ? "Restore page" : "Archive page"}
        </Button>
        {page.sourceThreadId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (page.sourceThreadId)
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: page.sourceThreadId },
                });
            }}
          >
            Open conversation
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={content.refresh}>
          Refresh content
        </Button>
      </div>
      {content.error ? (
        <p role="alert" className="text-sm text-destructive">
          {content.error}
        </p>
      ) : null}
      {content.isPending && !content.data ? <p>Loading page…</p> : null}
      {content.data?.content.kind === "html" ? (
        <iframe
          title={page.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={content.data.content.html}
          className="h-[60vh] w-full rounded-md border bg-white"
        />
      ) : content.data?.content.kind === "hostedUrl" ? (
        <a
          className="break-all text-sm underline"
          href={content.data.content.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open website · {content.data.content.url}
        </a>
      ) : null}
      {!page.archivedAt ? (
        <details>
          <summary className="cursor-pointer text-sm">Publish an update</summary>
          <div className="mt-3">
            <PageSaveForm
              key={page.currentRevisionId}
              initialTitle={page.title}
              maxDocumentBytes={maxDocumentBytes}
              busy={busy}
              kind={page.kind}
              onSave={(_title, nextContent) =>
                run({
                  type: "page.publish",
                  commandId: CommandId.make(randomUUID()),
                  pageId: page.id,
                  baseRevisionId: page.currentRevisionId,
                  content: nextContent,
                  dataAt: null,
                  createdAt: new Date().toISOString(),
                })
              }
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function PageSaveForm({
  initialTitle = "",
  kind,
  maxDocumentBytes,
  busy,
  onSave,
}: {
  readonly initialTitle?: string;
  readonly kind?: Page["kind"];
  readonly maxDocumentBytes: number;
  readonly busy: boolean;
  readonly onSave: (title: string, content: PageContentInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [mode, setMode] = useState(kind ?? "hostedUrl");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const save = async () => {
    if (busy || reading) return;
    setError(null);
    setReading(true);
    try {
      let content: PageContentInput;
      if (mode === "hostedUrl") {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "https:") throw new Error("Use an HTTPS website address.");
        content = { kind: "hostedUrl", url: parsed.href };
      } else {
        if (!file) throw new Error("Choose an HTML file.");
        if (file.size > maxDocumentBytes)
          throw new Error(
            `Choose a file smaller than ${Math.round(maxDocumentBytes / 1024 / 1024)} MB.`,
          );
        content = { kind: "html", html: await file.text() };
      }
      await onSave(title.trim(), content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the page.");
    } finally {
      setReading(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!initialTitle ? (
        <label className="text-sm">
          Title
          <Input
            required
            maxLength={PAGE_MAX_TITLE_LENGTH}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      ) : null}
      {!kind ? (
        <label className="flex flex-col gap-1 text-sm">
          Content
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value === "htmlDocument" ? "htmlDocument" : "hostedUrl")
            }
          >
            <option value="hostedUrl">Website link</option>
            <option value="htmlDocument">HTML document</option>
          </select>
        </label>
      ) : null}
      {mode === "hostedUrl" ? (
        <Input
          aria-label="Website address"
          required
          type="url"
          placeholder="https://example.com/report"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      ) : (
        <Input
          aria-label="HTML document"
          required
          type="file"
          accept=".html,.htm,text/html"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button disabled={busy || reading || !title.trim()} type="submit">
        {busy || reading ? "Saving…" : initialTitle ? "Publish update" : "Save page"}
      </Button>
    </form>
  );
}
