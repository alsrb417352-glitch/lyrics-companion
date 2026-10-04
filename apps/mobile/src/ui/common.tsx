import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import type { Theme } from './theme';

export function Button(props: {
  theme: Theme;
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
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
      <Text style={[styles.buttonText, { color: fg }]}>{props.label}</Text>
    </Pressable>
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
