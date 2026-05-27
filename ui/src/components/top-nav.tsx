import Link from "next/link";
import Image from "next/image";

// Global thin top nav. ~48px tall, border-bottom, monochromatic — matches
// DESIGN.md's developer-tool minimalism.
export function TopNav() {
  return (
    <header className="h-12 shrink-0 border-b border-border bg-background flex items-center px-4">
      <Link
        href="/sessions/"
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Image
          src="/logo.jpeg"
          alt="LiteLLM"
          width={28}
          height={28}
          className="rounded-sm"
          priority
        />
        <span>LiteLLM Harness</span>
      </Link>
    </header>
  );
}
