import type { ReactNode } from "react";

export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ id: "_static" }];
}

export default function AgentIdLayout({ children }: { children: ReactNode }) {
  return children;
}
