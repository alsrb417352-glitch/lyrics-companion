import type { ReactNode, SVGProps } from 'react';

/**
 * 직접 그린 선 아이콘(24×24 격자). 다른 서비스의 아이콘·로고는 쓰지 않는다(REQ-UI-06, D-32와 같은 원칙).
 * 아이콘만 있는 버튼은 반드시 aria-label을 받는다(IconButton).
 */
export type IconName =
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'back10'
  | 'fwd10'
  | 'note'
  | 'queue'
  | 'settings'
  | 'more'
  | 'close'
  | 'minus'
  | 'plus'
  | 'edit'
  | 'swap'
  | 'share'
  | 'tap'
  | 'undo'
  | 'cloud'
  | 'download'
  | 'upload'
  | 'check'
  | 'search'
  | 'window'
  | 'refresh'
  | 'external';

const PATHS: Record<IconName, ReactNode> = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  next: (
    <>
      <path d="M5 6v12l8.5-6z" fill="currentColor" stroke="none" />
      <path d="M12 6v12l8.5-6z" fill="currentColor" stroke="none" />
    </>
  ),
  prev: (
    <>
      <path d="M19 6v12l-8.5-6z" fill="currentColor" stroke="none" />
      <path d="M12 6v12L3.5 12z" fill="currentColor" stroke="none" />
    </>
  ),
  back10: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v3.5H8" />
      <text x="12" y="15.2" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">
        10
      </text>
    </>
  ),
  fwd10: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v3.5H16" />
      <text x="12" y="15.2" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">
        10
      </text>
    </>
  ),
  note: (
    <>
      <path d="M9 17.5V5.5l10-2v12" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </>
  ),
  queue: (
    <>
      <path d="M4 6.5h11M4 11.5h11M4 16.5h7" />
      <path d="M16 14v6l4.5-3z" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  minus: <path d="M6 12h12" />,
  plus: <path d="M6 12h12M12 6v12" />,
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  swap: (
    <>
      <path d="M5 8h13l-3.5-3.5" />
      <path d="M19 16H6l3.5 3.5" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M5 13v6h14v-6" />
    </>
  ),
  tap: (
    <>
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  undo: (
    <>
      <path d="M9 8H5V4" />
      <path d="M5 8a8 8 0 1 1-1 6" />
    </>
  ),
  cloud: <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z" />,
  download: (
    <>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M5 19h14" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  window: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2-4.9" />
      <path d="M19 4v4h-4" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5H5V6h5" />
    </>
  ),
};

export function Icon(props: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const { name, size = 20, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
