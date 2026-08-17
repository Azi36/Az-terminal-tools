/** 内联 SVG 图标，零依赖，描边跟随 currentColor */

type P = { size?: number };
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const IconSettings = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);

export const IconBack = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M19 12H5" />
    <path d="M12 19l-7-7 7-7" />
  </svg>
);

export const IconSun = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const IconMoon = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </svg>
);

export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconServer = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  </svg>
);

export const IconEdit = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const IconTrash = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const IconX = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const IconKey = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 8.3-8.3M17 5l2 2M15 7l2 2" />
  </svg>
);

export const IconLock = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const IconTerminal = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </svg>
);

export const IconFiles = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

export const IconFile = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </svg>
);

export const IconLink = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);

export const IconUp = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const IconRefresh = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </svg>
);

export const IconStar = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9Z" />
  </svg>
);

export const IconDownload = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 3v12M7 11l5 5 5-5M4 21h16" />
  </svg>
);

export const IconUpload = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 21V9M7 13l5-5 5 5M4 3h16" />
  </svg>
);

export const IconPlay = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6 4.5v15l13-7.5Z" />
  </svg>
);

export const IconCommand = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6 3a3 3 0 1 1-3 3h15a3 3 0 1 1 3 3v6a3 3 0 1 1-3 3H3a3 3 0 1 1 3-3Z" />
  </svg>
);

export const IconNote = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4 4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <path d="M15 2v5h5M8 12h8M8 16h5" />
  </svg>
);

export const IconSearch = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
);

export const IconMonitor = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const IconEye = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEyeOff = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.8A17 17 0 0 0 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4-.8" />
    <path d="M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
);

export const IconChevronDown = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconArrowLeft = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </svg>
);

export const IconCornerUp = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    <path d="m9 4-5 5 5 5" />
  </svg>
);

export const IconDatabase = ({ size }: P) => (
  <svg {...base(size)}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

export const IconFilePlus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6M12 12v6M9 15h6" />
  </svg>
);

export const IconArrowUpRight = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

export const IconChevronRight = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconFileEdit = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5" />
    <path d="M14 2v6h6" />
    <path d="M18.4 12.6a1.9 1.9 0 0 1 2.7 2.7L16.5 20l-3 .7.7-3Z" />
  </svg>
);

export const IconHome = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
  </svg>
);

export const IconDrive = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M5 13 7.5 4h9L19 13M6 17h.01M10 17h4" />
  </svg>
);

export const IconCheck = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const IconSparkle = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 3v6M12 15v6M3 12h6M15 12h6M6.3 6.3l3 3M14.7 14.7l3 3M17.7 6.3l-3 3M9.3 14.7l-3 3" />
  </svg>
);

/** 目录同步：两条带箭头的弧，一去一回 */
export const IconSync = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-7.5 4" />
    <path d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 7.5-4" />
    <path d="M4.5 3v4h4M19.5 21v-4h-4" />
  </svg>
);

export const IconFolderPlus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </svg>
);
