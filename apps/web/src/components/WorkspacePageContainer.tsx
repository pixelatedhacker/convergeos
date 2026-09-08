import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

export type WorkspacePageWidth = "readable" | "wide" | "expanded";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-4xl",
  wide: "max-w-5xl",
  expanded: "max-w-6xl",
};

/** Shared content frame for workspace pages. */
export function WorkspacePageContainer({
  width = "readable",
  title,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  readonly width?: WorkspacePageWidth;
  /** Page heading rendered at the top of the content frame. The topbar
      breadcrumb keeps wayfinding; this carries the page's hierarchy. */
  readonly title?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6",
        WIDTH_CLASS[width],
        className,
      )}
      {...props}
    >
      {title === undefined ? null : (
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      )}
      {children}
    </div>
  );
}
