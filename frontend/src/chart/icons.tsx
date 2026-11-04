// Small line icons for the chart toolbars (18 × 18, drawn with currentColor).
import type { ReactNode } from "react";

const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r={1.7} fill="currentColor" stroke="none" />;

const PATHS: Record<string, ReactNode> = {
  cursor: <path d="M5 2.5l9.5 7.2-4.3.9 2.6 4.6-1.9 1.1-2.6-4.6-3.3 3z" />,
  trend: (
    <>
      <path d="M4.5 14.5l9-9" />
      {dot(4, 15)}
      {dot(14, 4)}
    </>
  ),
  ray: (
    <>
      <path d="M4.5 14.5L16.5 2.5" />
      {dot(4, 15)}
      {dot(9.5, 9.5)}
    </>
  ),
  extended: (
    <>
      <path d="M1.5 16.5l15-15" />
      {dot(6.5, 11.5)}
      {dot(11.5, 6.5)}
    </>
  ),
  arrow: <path d="M3.5 14.5L14 4M8.8 4H14v5.2" />,
  hline: (
    <>
      <path d="M1.5 9h15" />
      {dot(9, 9)}
    </>
  ),
  hray: (
    <>
      <path d="M5 9h11.5" />
      {dot(4.5, 9)}
    </>
  ),
  vline: (
    <>
      <path d="M9 1.5v15" />
      {dot(9, 9)}
    </>
  ),
  rect: <rect x={2.5} y={4.5} width={13} height={9} rx={1} />,
  channel: <path d="M1.5 11.5L11 3M7 15.5l9.5-8.5" />,
  fib: <path d="M2 3.5h14M2 7h14M2 10.5h14M2 14.5h14" />,
  measure: <path d="M9 2v14M6 4.8L9 2l3 2.8M6 13.2L9 16l3-2.8M3 6v6M15 6v6" />,
  text: <path d="M3.5 4V2.8h11V4M9 2.8v12.4M6.5 15.2h5" />,
  zoom: <path d="M7.5 2.8a4.7 4.7 0 1 0 0 9.4a4.7 4.7 0 0 0 0-9.4zM11 11l5 5M5.5 7.5h4M7.5 5.5v4" />,
  magnet: <path d="M4 3v6a5 5 0 0 0 10 0V3h-3v6a2 2 0 0 1-4 0V3zM4 6h3M11 6h3" />,
  stay: <path d="M3 15l.9-3.9L12 3l3 3-8.1 8.1zM10.5 4.5l3 3" />,
  lock: <path d="M5 8.5V6a4 4 0 0 1 8 0v2.5M3.8 8.5h10.4v7.5H3.8z" />,
  eye: <path d="M1.5 9S4.3 4 9 4s7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM9 6.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 0 0 0-4.4z" />,
  eyeOff: <path d="M2.5 2.5l13 13M7 4.3A7.6 7.6 0 0 1 9 4c4.7 0 7.5 5 7.5 5a12 12 0 0 1-2 2.6M11 13.6A6.8 6.8 0 0 1 9 14c-4.7 0-7.5-5-7.5-5a12.7 12.7 0 0 1 2.6-3.1" />,
  trash: <path d="M3 5h12M7 5V3h4v2M4.5 5l.8 11h7.4l.8-11M7.5 8v5M10.5 8v5" />,
  undo: <path d="M6.5 3.5L3 7l3.5 3.5M3 7h8a4.5 4.5 0 0 1 0 9H8" />,
  redo: <path d="M11.5 3.5L15 7l-3.5 3.5M15 7H7a4.5 4.5 0 0 0 0 9h3" />,
  camera: <path d="M2 5.5h3.2l1.3-2h5l1.3 2H16v10H2zM9 7.5a3 3 0 1 0 0 6a3 3 0 0 0 0-6z" />,
  fullscreen: <path d="M2 6.5V2h4.5M11.5 2H16v4.5M16 11.5V16h-4.5M6.5 16H2v-4.5" />,
  exitFullscreen: <path d="M6.5 2v4.5H2M16 6.5h-4.5V2M11.5 16v-4.5H16M2 11.5h4.5V16" />,
  clone: <path d="M6 6h9.5v9.5H6zM3 12V3h9" />,
  zoomIn: <path d="M9 3.5v11M3.5 9h11" />,
  zoomOut: <path d="M3.5 9h11" />,
  reset: <path d="M3.5 9a5.5 5.5 0 1 0 1.8-4.1M3 2.5V6h3.5" />,
  fit: <path d="M2 9h14M5 6l-3 3 3 3M13 6l3 3-3 3" />,
  latest: <path d="M4 4.5L8.5 9 4 13.5M9.5 4.5L14 9l-4.5 4.5" />,
  settings: <path d="M9 6.3a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 0 0 0-5.4zM9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" />,
  close: <path d="M4 4l10 10M14 4L4 14" />,
  indicators: <path d="M2 14.5l3.5-5 3 2.5 3-6 4.5 4M2 2v14h14" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
