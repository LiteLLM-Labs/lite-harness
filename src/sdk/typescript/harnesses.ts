import { Transport } from "./transport.js";
import type { AgentOptions } from "./types.js";

export interface HarnessMetadata {
  id: string;
  providerId: string;
  name: string;
  aliases: string[];
}

function listLaunchArgs(): string[] {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function decodeHarness(value: unknown): HarnessMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.providerId !== "string" ||
    typeof item.name !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
    providerId: item.providerId,
    name: item.name,
    aliases: asStringArray(item.aliases),
  };
}

export async function listHarnesses({
  options = {},
}: {
  options?: Pick<AgentOptions, "cwd" | "env" | "stderr" | "abortController">;
} = {}): Promise<HarnessMetadata[]> {
  const transport = new Transport({
    cwd: options.cwd,
    env: options.env,
    stderr: options.stderr,
    abortController: options.abortController,
    args: listLaunchArgs(),
  });

  try {
    transport.connect();
    const response = await transport.sendControl("list_harnesses");
    const harnesses = Array.isArray(response.harnesses) ? response.harnesses : [];
    return harnesses.flatMap((item) => {
      const harness = decodeHarness(item);
      return harness ? [harness] : [];
    });
  } finally {
    transport.markClosed();
    await transport.shutdownGraceful();
  }
}
