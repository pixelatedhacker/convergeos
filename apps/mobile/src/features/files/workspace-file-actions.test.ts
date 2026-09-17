import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { workspaceFileDownloadResource, workspaceFileMetadata } from "./workspace-file-actions";

const threadId = ThreadId.make("files");

describe("workspace file actions", () => {
  it.each([
    ["reports/Quarterly résumé.PDF", "Quarterly résumé.PDF", "application/pdf"],
    [
      "C:\\repo\\slides.pptx",
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["src/main.ts", "main.ts", "text/plain"],
    ["backup.zip", "backup.zip", "application/zip"],
    ["README.md", "README.md", "text/plain"],
    ["data.unknown", "data.unknown", "application/octet-stream"],
  ])("preserves the name and selects a native type for %s", (path, name, mimeType) => {
    expect(workspaceFileMetadata(path)).toEqual({ name, mimeType });
  });

  it.each(["reports/data.xlsx", "/repo/reports/data.xlsx"])(
    "requests original bytes for %s",
    (path) => {
      expect(workspaceFileDownloadResource("/repo", path, threadId)).toEqual({
        _tag: "workspace-file",
        threadId,
        path: "reports/data.xlsx",
        download: true,
      });
    },
  );

  it("downloads from a project draft before a thread exists", () => {
    expect(workspaceFileDownloadResource("/repo", "/repo/report.txt", null)).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "report.txt",
      download: true,
    });
  });

  it("preserves the host media route for files outside the workspace", () => {
    expect(workspaceFileDownloadResource("/repo", "/tmp/photo.png", threadId)).toEqual({
      _tag: "media-file",
      threadId,
      path: "/tmp/photo.png",
      download: true,
    });
  });
});
