// Brand logos for integrations, rendered as inline SVG so they scale crisply
// and pick up no external assets. Keyed by integration id.

import type { ReactNode, SVGProps } from "react";

function GmailIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8 4.924 8 3 9.924 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8 43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
}

function LinearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="#5E6AD2"
        d="M2.886 4.18A11.982 11.982 0 0 1 11.838 0L2.886 8.952V4.18ZM.21 9.683 9.683.21a11.987 11.987 0 0 0-3.092 1.149L1.36 6.59A11.987 11.987 0 0 0 .21 9.683Zm.045 4.052L13.735.255a12.018 12.018 0 0 0-1.79.097L.352 11.945a12.018 12.018 0 0 0-.097 1.79Zm.836 3.456L17.243 1.09a12.06 12.06 0 0 0-1.371-.71L.38 15.872c.18.484.418.943.71 1.371Zm2.04 2.51L19.728 3.66a12.066 12.066 0 0 0-1.04-1.184L2.475 18.69c.367.385.763.732 1.184 1.04Zm3.158 1.86L21.96 6.752a11.918 11.918 0 0 0-.72-1.398L5.354 21.24c.443.275.911.516 1.398.72ZM12 24c6.627 0 12-5.373 12-12 0-.34-.014-.675-.041-1.008L11.008 23.96c.333.027.668.041 1.008.041Z"
      />
    </svg>
  );
}

function PylonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="32" height="32" rx="8" fill="#6D4AFF" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        d="M16 7a9 9 0 1 0 9 9"
      />
      <circle cx="16" cy="16" r="3.2" fill="#fff" />
    </svg>
  );
}

function SlackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 122.8 122.8" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="#36C5F0"
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
      />
      <path
        fill="#2EB67D"
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
      />
      <path
        fill="#ECB22E"
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
      />
      <path
        fill="#E01E5A"
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
      />
    </svg>
  );
}

function FallbackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M14 7h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5M10 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h5M8 12h8" />
    </svg>
  );
}

const ICONS: Record<string, (p: SVGProps<SVGSVGElement>) => ReactNode> = {
  gmail: GmailIcon,
  linear: LinearIcon,
  pylon: PylonIcon,
  slack: SlackIcon,
};

export function BrandIcon({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const Icon = ICONS[id] ?? FallbackIcon;
  return <Icon className={className} />;
}
