import { useColorScheme } from 'react-native';

/** 자체 디자인 색상(Apple 자산·로고 미사용, REQ-UI-06). 어두운 배경에서 현재 행이 잘 보이도록 대비를 높였다. */
export interface Theme {
  bg: string;
  surface: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentText: string;
  danger: string;
  border: string;
}

const dark: Theme = {
  bg: '#101216',
  surface: '#1b1e24',
  text: '#f4f5f7',
  textDim: '#a8adb7',
  textFaint: '#5d636e',
  accent: '#ff5a7a',
  accentText: '#ffffff',
  danger: '#ff6b6b',
  border: '#2a2e36',
};

const light: Theme = {
  bg: '#f6f6f8',
  surface: '#ffffff',
  text: '#121317',
  textDim: '#4c515c',
  textFaint: '#a3a8b1',
  accent: '#d9264c',
  accentText: '#ffffff',
  danger: '#c62828',
  border: '#e3e4e8',
};

export function useTheme(): Theme {
  return useColorScheme() === 'light' ? light : dark;
}
