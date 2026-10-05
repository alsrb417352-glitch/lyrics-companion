import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LyricRowView, LyricsScreenView } from '@lyrics-companion/core';
import type { Theme } from './theme';
import { Button } from './common';

/**
 * 가사 목록: 원문·발음·번역을 한 행 묶음으로 표시(REQ-UI-02).
 * 현재 행으로 자동 스크롤하되, 사용자가 직접 스크롤하면 추적을 멈추고 "현재 가사로" 버튼을 보인다(REQ-UI-05).
 * '동작 줄이기'가 켜져 있으면 애니메이션 없이 이동한다(REQ-UI-04). 글자 크기는 시스템 설정을 따른다.
 */
function LyricsListImpl(props: { theme: Theme; view: LyricsScreenView; onPressLine?: (index: number) => void }) {
  const { theme, view } = props;
  // 탭 처리 함수는 ref로 들고 있어, 부모가 다시 그려져도 행 렌더 함수가 바뀌지 않게 한다(불필요한 재렌더 방지).
  const pressRef = useRef(props.onPressLine);
  pressRef.current = props.onPressLine;
  const canPress = !!props.onPressLine;
  const list = useRef<FlatList<LyricRowView>>(null);
  const [follow, setFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!follow || view.activeIndex === null || view.rows.length === 0) return;
    list.current?.scrollToIndex({ index: view.activeIndex, viewPosition: 0.35, animated: !reduceMotion });
  }, [view.activeIndex, follow, reduceMotion, view.rows.length]);

  const backToCurrent = useCallback(() => setFollow(true), []);

  const renderItem = useCallback(
    ({ item, index }: { item: LyricRowView; index: number }) => {
      const active = item.state === 'active';
      const past = item.state === 'past';
      const color = active ? theme.text : past ? theme.textFaint : view.mode === 'synced' ? theme.textDim : theme.text;
      return (
        <Pressable
          onPress={canPress ? () => pressRef.current?.(index) : undefined}
          accessible
          accessibilityLabel={item.accessibilityLabel}
          accessibilityState={{ selected: active }}
          style={styles.row}
        >
          <Text style={[styles.original, { color, fontWeight: active ? '800' : '700' }]}>{item.original || ' '}</Text>
          {item.pronunciation ? (
            <Text style={[styles.pron, { color: active ? theme.accent : theme.textFaint }]}>{item.pronunciation}</Text>
          ) : null}
          {item.translation ? (
            <Text style={[styles.trans, { color: active ? theme.text : theme.textDim }]}>{item.translation}</Text>
          ) : null}
        </Pressable>
      );
    },
    [theme, view.mode, canPress],
  );

  return (
    <View style={styles.container}>
      <FlatList
        ref={list}
        data={view.rows}
        keyExtractor={(r) => r.lineId}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        onScrollBeginDrag={() => setFollow(false)}
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        }}
        ListFooterComponent={<View style={{ height: 240 }} />}
      />
      {!follow && view.mode === 'synced' ? (
        <View style={styles.floating}>
          <Button theme={theme} kind="primary" label="현재 가사로" onPress={backToCurrent} />
        </View>
      ) : null}
    </View>
  );
}

/** 같은 화면 구성(view)·테마면 다시 그리지 않는다 */
export const LyricsList = memo(
  LyricsListImpl,
  (a, b) => a.view === b.view && a.theme === b.theme && !!a.onPressLine === !!b.onPressLine,
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  row: { paddingVertical: 12 },
  original: { fontSize: 26, lineHeight: 34 },
  pron: { fontSize: 16, lineHeight: 22, marginTop: 4 },
  trans: { fontSize: 19, lineHeight: 26, marginTop: 4 },
  floating: { position: 'absolute', right: 16, bottom: 16 },
});
