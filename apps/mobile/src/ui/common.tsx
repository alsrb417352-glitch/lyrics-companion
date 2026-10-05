import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './icons';
import type { Theme } from './theme';

export function Button(props: {
  theme: Theme;
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** 글자 앞에 붙일 아이콘 */
  icon?: IconName;
}) {
  const { theme, kind = 'plain', disabled } = props;
  const bg = kind === 'primary' ? theme.accent : theme.surface;
  const fg = kind === 'primary' ? theme.accentText : kind === 'danger' ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: theme.border, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        props.style,
      ]}
    >
      <View style={styles.buttonRow}>
        {props.icon ? <Icon name={props.icon} size={18} color={fg} /> : null}
        <Text style={[styles.buttonText, { color: fg }]}>{props.label}</Text>
      </View>
    </Pressable>
  );
}

/**
 * 원형 아이콘 버튼(재생 컨트롤 등). 글자가 없으므로 접근성 이름(label)을 반드시 받는다.
 * - primary: 강조색으로 채운 원(재생·일시정지)
 * - soft: 옅은 면 위 아이콘
 * - ghost: 배경 없이 아이콘만
 */
export function IconButton(props: {
  theme: Theme;
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: number;
  iconSize?: number;
  kind?: 'primary' | 'soft' | 'ghost';
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme, kind = 'ghost', size = 44, disabled } = props;
  const iconSize = props.iconSize ?? Math.round(size * 0.55);
  const bg = kind === 'primary' ? theme.accent : kind === 'soft' ? theme.surface : 'transparent';
  const fg = props.color ?? (kind === 'primary' ? theme.accentText : theme.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      hitSlop={size < 44 ? (44 - size) / 2 : 0}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        props.style,
      ]}
    >
      <Icon name={props.icon} size={iconSize} color={fg} />
    </Pressable>
  );
}

/** 이름으로 정해지는 아트워크 색(같은 이름은 항상 같은 색). 실제 앨범 아트 대신 쓰는 자체 디자인 타일 */
const TILE_COLORS = ['#ff5a7a', '#ff8a3d', '#f5b82e', '#3ccf8e', '#2fb7d6', '#5b7cfa', '#9b6bff', '#e05bd0'];

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function ArtworkTile(props: { seed: string; size: number; icon?: IconName; radius?: number }) {
  const { size } = props;
  const c1 = TILE_COLORS[hashOf(props.seed) % TILE_COLORS.length] ?? '#5b7cfa';
  const c2 = TILE_COLORS[(hashOf(props.seed) + 3) % TILE_COLORS.length] ?? '#9b6bff';
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: props.radius ?? Math.max(6, size * 0.12),
        backgroundColor: c1,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* 두 번째 색 원을 모서리에 겹쳐 단색보다 입체감 있게(그라데이션 라이브러리 없이) */}
      <View
        style={{
          position: 'absolute',
          width: size * 1.1,
          height: size * 1.1,
          borderRadius: size,
          backgroundColor: c2,
          opacity: 0.55,
          right: -size * 0.55,
          bottom: -size * 0.55,
        }}
      />
      <Icon name={props.icon ?? 'note'} size={Math.round(size * 0.42)} color="rgba(255,255,255,0.92)" />
    </View>
  );
}

export function Chip(props: { theme: Theme; label: string; on: boolean; onPress: () => void }) {
  const { theme, on } = props;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={[
        styles.chip,
        { borderColor: on ? theme.accent : theme.border, backgroundColor: on ? theme.accent : 'transparent' },
      ]}
    >
      <Text style={{ color: on ? theme.accentText : theme.textDim, fontSize: 14, fontWeight: '600' }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function Note(props: { theme: Theme; children: ReactNode; tone?: 'dim' | 'danger' }) {
  return (
    <Text
      style={{
        color: props.tone === 'danger' ? props.theme.danger : props.theme.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginVertical: 4,
      }}
    >
      {props.children}
    </Text>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 8,
    minHeight: 32,
    justifyContent: 'center',
  },
});
