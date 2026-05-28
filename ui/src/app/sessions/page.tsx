"use client";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHarness } from "@/lib/use-harness";

export default function SessionsPage() {
  const [harness, setHarness] = useHarness();
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-end gap-2 px-4 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">harness</span>
            <Select value={harness} onValueChange={(v) => v && setHarness(v as "opencode" | "claude-code" | "github-copilot")}>
              <SelectTrigger className="h-8 text-xs w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opencode" className="text-xs font-mono">opencode</SelectItem>
                <SelectItem value="claude-code" className="text-xs font-mono">claude code</SelectItem>
                <SelectItem value="github-copilot" className="text-xs font-mono">github copilot</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ThemeToggle />
        </header>
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <h1 className="text-2xl font-semibold mb-2">lite-harness</h1>
            <p className="text-sm text-muted-foreground">
              Pick a session from the left, or click{" "}
              <span className="font-medium">+ New session</span> to start.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
