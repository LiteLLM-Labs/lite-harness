"use client";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

export default function SessionsPage() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-end px-4 shrink-0">
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
