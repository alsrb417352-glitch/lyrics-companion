import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createAppServices, type AppServices } from '../services';
import { NowPlayingScreen } from './NowPlayingScreen';
import { PlaylistsScreen } from './PlaylistsScreen';
import { SearchScreen } from './SearchScreen';
import { SettingsScreen } from './SettingsScreen';
import { Icon, type IconName } from './icons';
import { useTheme, type Theme } from './theme';
import { usePlayback } from './usePlayback';

type Tab = 'now' | 'playlists' | 'search' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'now', label: '지금 재생', icon: 'note' },
  { id: 'playlists', label: '플레이리스트', icon: 'playlist' },
  { id: 'search', label: '검색', icon: 'search' },
  { id: 'settings', label: '설정', icon: 'settings' },
];

function Main(props: { services: AppServices; theme: Theme }) {
  const { services, theme } = props;
  const [tab, setTab] = useState<Tab>('now');
  const playback = usePlayback(services);
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.bg }]} edges={['top', 'bottom']}>
      <View style={styles.flex}>
        {tab === 'now' ? <NowPlayingScreen services={services} playback={playback} theme={theme} /> : null}
        {tab === 'playlists' ? (
          <PlaylistsScreen
            services={services}
            playback={playback}
            theme={theme}
            onOpenNowPlaying={() => setTab('now')}
          />
        ) : null}
        {tab === 'search' ? (
          <SearchScreen services={services} playback={playback} theme={theme} onOpenNowPlaying={() => setTab('now')} />
        ) : null}
        {tab === 'settings' ? <SettingsScreen services={services} theme={theme} /> : null}
      </View>
      <View style={[styles.tabs, { borderColor: theme.border, backgroundColor: theme.bg }]} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
            onPress={() => setTab(t.id)}
            style={styles.tab}
          >
            <Icon name={t.icon} size={24} color={tab === t.id ? theme.accent : theme.textDim} />
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{
                color: tab === t.id ? theme.accent : theme.textDim,
                fontSize: 11,
                fontWeight: '600',
                marginTop: 2,
              }}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

export function Root() {
  const theme = useTheme();
  const [services, setServices] = useState<AppServices | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createAppServices().then(setServices, (e: unknown) => {
      // 저장소 마이그레이션 실패 등. 원문 오류에는 비밀정보가 없지만 길이를 제한해 보여 준다.
      setError(e instanceof Error ? e.message.slice(0, 300) : '초기화 실패');
    });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {services ? (
        <Main services={services} theme={theme} />
      ) : (
        <View style={[styles.center, { backgroundColor: theme.bg }]}>
          {error ? (
            <Text style={{ color: theme.danger, fontSize: 16 }}>앱을 시작하지 못했습니다: {error}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 4,
    paddingHorizontal: 4,
    minHeight: 52,
  },
});
