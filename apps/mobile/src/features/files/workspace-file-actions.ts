import { filePreviewKind, hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

import type { AssetResource, ThreadId } from "@t3tools/contracts";
import { basename, resolveWorkspaceRelativeFilePath } from "./filePath";

const DOCUMENT_MIME_TYPES = new Map([
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".zip", "application/zip"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".rtf", "application/rtf"],
]);

export function workspaceFileMetadata(path: string) {
  const name = basename(path);
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const kind = filePreviewKind({ name });
  const mimeType =
    hostPreviewMimeTypeFromExtension(extension) ??
    DOCUMENT_MIME_TYPES.get(extension) ??
    (kind === "text" || kind === "markdown" ? "text/plain" : "application/octet-stream");
  return { name, mimeType };
}

export function workspaceFileDownloadResource(
  cwd: string,
  path: string,
  threadId: ThreadId | null,
): AssetResource {
  const relativePath = resolveWorkspaceRelativeFilePath(cwd, path);
  if (threadId === null)
    return { _tag: "draft-workspace-file", cwd, path: relativePath ?? path, download: true };
  return relativePath === null
    ? { _tag: "media-file", threadId, path, download: true }
    : { _tag: "workspace-file", threadId, path: relativePath, download: true };
}
