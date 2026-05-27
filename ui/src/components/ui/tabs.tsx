"use client";

// Minimal pill-style tabs. shadcn's Tabs primitive isn't installed here and
// we only need a two-button toggle, so this is a tiny controlled wrapper.

import React from "react";
import { cn } from "@/lib/utils";

export interface TabItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
}

export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  className,
}: {
  value: T;
  onValueChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onValueChange(it.value)}
            className={cn(
              "px-3 h-7 text-xs rounded transition-colors",
              active
                ? "bg-background text-foreground border border-border shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
