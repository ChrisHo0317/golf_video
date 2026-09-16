type P = { size?: number };
const base = (size = 22) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconList = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
export const IconGear = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const IconBack = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);
export const IconLayers = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
);
export const IconPlay = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 4v16l13-8z" fill="currentColor" />
  </svg>
);
export const IconPause = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" />
  </svg>
);
export const IconPrev = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M18 18 10 12l8-6zM6 6v12" />
  </svg>
);
export const IconNext = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l8 6-8 6zM18 6v12" />
  </svg>
);
export const IconStar = ({ size, filled }: P & { filled?: boolean }) => (
  <svg {...base(size)}>
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" fill={filled ? 'currentColor' : 'none'} />
  </svg>
);
export const IconTrash = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);
export const IconTarget = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const IconDownload = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
  </svg>
);
export const IconCamera = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 8h4l2-3h6l2 3h4v12H3z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);
