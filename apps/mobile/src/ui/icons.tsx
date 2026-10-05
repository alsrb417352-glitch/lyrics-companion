import type { ReactNode } from 'react';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';

/**
 * 앱 자체 아이콘(직접 그린 단순 도형, 24×24 기준). 다른 서비스의 아이콘·로고를 쓰지 않는다(REQ-UI-06).
 * 채움 아이콘(재생·일시정지 등)과 선 아이콘(검색·목록 등)을 섞어 쓰며 색은 테마에서 받는다.
 */
export type IconName =
  | 'play'
  | 'pause'
  | 'prev'
  | 'next'
  | 'back10'
  | 'fwd10'
  | 'shuffle'
  | 'note'
  | 'playlist'
  | 'search'
  | 'settings'
  | 'check'
  | 'chevronLeft'
  | 'chevronRight'
  | 'more'
  | 'download'
  | 'close'
  | 'minus'
  | 'plus'
  | 'library'
  | 'cloud'
  | 'tap'
  | 'edit'
  | 'share'
  | 'swap'
  | 'undo'
  | 'refresh';

export function Icon(props: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  const { name, size = 24, color } = props;
  const sw = props.strokeWidth ?? 2;
  const line = {
    stroke: color,
    strokeWidth: sw,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  let body: ReactNode;
  switch (name) {
    case 'play':
      body = (
        <Path
          d="M8 4.8v14.4c0 .8.86 1.28 1.54.86l11.3-7.2a1 1 0 0 0 0-1.72L9.54 3.94C8.86 3.52 8 4 8 4.8z"
          fill={color}
        />
      );
      break;
    case 'pause':
      body = (
        <>
          <Rect x={6} y={4} width={4.2} height={16} rx={1.4} fill={color} />
          <Rect x={13.8} y={4} width={4.2} height={16} rx={1.4} fill={color} />
        </>
      );
      break;
    case 'prev':
      body = (
        <>
          <Rect x={4} y={5} width={2.6} height={14} rx={1.1} fill={color} />
          <Path
            d="M20 6.2v11.6c0 .78-.84 1.26-1.5.86L9.3 13a1.2 1.2 0 0 1 0-2l9.2-5.66c.66-.4 1.5.08 1.5.86z"
            fill={color}
          />
        </>
      );
      break;
    case 'next':
      body = (
        <>
          <Rect x={17.4} y={5} width={2.6} height={14} rx={1.1} fill={color} />
          <Path
            d="M4 6.2v11.6c0 .78.84 1.26 1.5.86L14.7 13a1.2 1.2 0 0 0 0-2L5.5 5.34C4.84 4.94 4 5.42 4 6.2z"
            fill={color}
          />
        </>
      );
      break;
    case 'back10':
    case 'fwd10': {
      const fwd = name === 'fwd10';
      body = (
        <>
          <Path d={fwd ? 'M12 3.5a8.5 8.5 0 1 1-8.5 8.5' : 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5'} {...line} />
          <Path d={fwd ? 'M9.5 1.2 12.4 3.5 9.5 5.8' : 'M14.5 1.2 11.6 3.5 14.5 5.8'} {...line} />
          <SvgText x={12} y={15.6} fontSize={8.4} fontWeight="700" fill={color} textAnchor="middle">
            10
          </SvgText>
        </>
      );
      break;
    }
    case 'shuffle':
      body = (
        <>
          <Path d="M3 7h3.2c1.4 0 2.7.7 3.5 1.9l4.6 6.2c.8 1.2 2.1 1.9 3.5 1.9H21" {...line} />
          <Path d="M3 17h3.2c1.4 0 2.7-.7 3.5-1.9l.6-.8M13.7 9.7l.6-.8C15.1 7.7 16.4 7 17.8 7H21" {...line} />
          <Path d="M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5" {...line} />
        </>
      );
      break;
    case 'note':
      body = (
        <>
          <Path d="M9 18V5.5l11-2v12.5" {...line} />
          <Circle cx={6.5} cy={18} r={2.5} {...line} />
          <Circle cx={17.5} cy={16} r={2.5} {...line} />
        </>
      );
      break;
    case 'playlist':
      body = (
        <>
          <Path d="M3.5 6h11M3.5 11h11M3.5 16h6" {...line} />
          <Path d="M17.5 17.5V8.5l3.5-1" {...line} />
          <Circle cx={15.5} cy={17.5} r={2} {...line} />
        </>
      );
      break;
    case 'library':
      body = (
        <>
          <Path d="M5 4v16M9.5 4v16" {...line} />
          <Path d="m14 4.6 4.8 15" {...line} />
        </>
      );
      break;
    case 'search':
      body = (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} {...line} />
          <Path d="m15.5 15.5 5 5" {...line} />
        </>
      );
      break;
    case 'settings':
      body = (
        <>
          <Path d="M4 7h9M17 7h3M4 17h3M11 17h9" {...line} />
          <Circle cx={15} cy={7} r={2} {...line} />
          <Circle cx={9} cy={17} r={2} {...line} />
        </>
      );
      break;
    case 'check':
      body = <Path d="m5 12.5 4.5 4.5L19 7.5" {...line} />;
      break;
    case 'chevronLeft':
      body = <Path d="M15 5 8 12l7 7" {...line} />;
      break;
    case 'chevronRight':
      body = <Path d="m9 5 7 7-7 7" {...line} />;
      break;
    case 'more':
      body = (
        <>
          <Circle cx={5.5} cy={12} r={1.8} fill={color} />
          <Circle cx={12} cy={12} r={1.8} fill={color} />
          <Circle cx={18.5} cy={12} r={1.8} fill={color} />
        </>
      );
      break;
    case 'download':
      body = (
        <>
          <Path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" {...line} />
          <Path d="M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" {...line} />
        </>
      );
      break;
    case 'cloud':
      body = (
        <>
          <Path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9H7z" {...line} />
        </>
      );
      break;
    case 'close':
      body = <Path d="M6 6l12 12M18 6 6 18" {...line} />;
      break;
    case 'minus':
      body = <Path d="M6 12h12" {...line} />;
      break;
    case 'plus':
      body = <Path d="M12 6v12M6 12h12" {...line} />;
      break;
    case 'tap':
      body = (
        <>
          <Circle cx={12} cy={12} r={3} fill={color} />
          <Circle cx={12} cy={12} r={7.5} {...line} />
        </>
      );
      break;
    case 'edit':
      body = (
        <>
          <Path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" {...line} />
          <Path d="m13.5 6.5 4 4" {...line} />
        </>
      );
      break;
    case 'share':
      body = (
        <>
          <Path d="M12 3.5v11M8 7.5l4-4 4 4" {...line} />
          <Path
            d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1"
            {...line}
          />
        </>
      );
      break;
    case 'swap':
      body = (
        <>
          <Path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5" {...line} />
          <Path d="M20 16H6M9.5 12.5 6 16l3.5 3.5" {...line} />
        </>
      );
      break;
    case 'refresh':
      body = (
        <>
          <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" {...line} />
          <Path d="M19.5 4v4.5H15" {...line} />
        </>
      );
      break;
    case 'undo':
      body = (
        <>
          <Path d="M9 7 4.5 11.5 9 16" {...line} />
          <Path d="M5 11.5h9a5 5 0 0 1 0 10h-2" {...line} />
        </>
      );
      break;
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      {body}
    </Svg>
  );
}
