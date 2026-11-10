// Original, minimal stroke icons (16px grid).
import type { JSX } from "solid-js";

function Svg(p: { children: JSX.Element; size?: number; title?: string }) {
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden={p.title ? undefined : "true"} role={p.title ? "img" : undefined}>
      {p.title && <title>{p.title}</title>}
      {p.children}
    </svg>
  );
}

export const IconBranch = (p: { size?: number }) => (
  <Svg size={p.size}>
    <circle cx="5" cy="3.5" r="1.6" />
    <circle cx="5" cy="12.5" r="1.6" />
    <circle cx="11" cy="5.5" r="1.6" />
    <path d="M5 5.1v5.8M11 7.1c0 2.6-6 1.6-6 3.8" />
  </Svg>
);
export const IconTag = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
    <circle cx="5.5" cy="5.5" r="1" />
  </Svg>
);
export const IconStash = (p: { size?: number }) => (
  <Svg size={p.size}>
    <rect x="2.5" y="3" width="11" height="3" rx="0.8" />
    <path d="M3.5 6v6.5h9V6M6.5 8.5h3" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.3" />
    <path d="M10.2 10.2 14 14" />
  </Svg>
);
export const IconGear = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
  </Svg>
);
export const IconFetch = () => (
  <Svg>
    <path d="M4.5 11.5h-.3a3 3 0 0 1-.4-6 4.2 4.2 0 0 1 8.2.9 2.6 2.6 0 0 1 .3 5.1h-.8" />
    <path d="M8 7.5v6M5.8 11.4 8 13.6l2.2-2.2" />
  </Svg>
);
export const IconRefresh = () => (
  <Svg>
    <path d="M13.2 7.6A5.2 5.2 0 1 1 11.6 4" />
    <path d="M12.2 1.8v2.8H9.4" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconUp = () => (
  <Svg>
    <path d="M4 10l4-4 4 4" />
  </Svg>
);
export const IconDown = () => (
  <Svg>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const IconFile = () => (
  <Svg>
    <path d="M4 1.8h5.2l2.8 2.8v9.6H4z" />
    <path d="M9 1.8v3h3" />
  </Svg>
);
export const IconFolder = () => (
  <Svg>
    <path d="M1.8 4.2h4.4l1.4 1.5h6.6v7.5H1.8z" />
  </Svg>
);
export const IconUser = () => (
  <Svg>
    <circle cx="8" cy="5.5" r="2.6" />
    <path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" />
  </Svg>
);
export const IconTree = () => (
  <Svg>
    <path d="M3 3h4M5 3v9h4M5 7.5h4" />
    <circle cx="11" cy="7.5" r="1.3" />
    <circle cx="11" cy="12" r="1.3" />
  </Svg>
);
export const IconList = () => (
  <Svg>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1" />
  </Svg>
);
export const IconPlug = () => (
  <Svg>
    <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />
  </Svg>
);
