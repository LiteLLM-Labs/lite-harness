"use client";

import { useState } from "react";

const KEY = "harness";

export function useHarness() {
  const [harness, setHarnessState] = useState<"opencode" | "claude-code" | "github-copilot">(() => {
    if (typeof window === "undefined") return "opencode";
    return (localStorage.getItem(KEY) as "opencode" | "claude-code" | "github-copilot") ?? "opencode";
  });

  const setHarness = (v: "opencode" | "claude-code" | "github-copilot") => {
    localStorage.setItem(KEY, v);
    setHarnessState(v);
  };

  return [harness, setHarness] as const;
}

export function readHarness(): "opencode" | "claude-code" | "github-copilot" {
  if (typeof window === "undefined") return "opencode";
  return (localStorage.getItem(KEY) as "opencode" | "claude-code" | "github-copilot") ?? "opencode";
}
