/**
 * 서비스 워커: 도구 모음의 확장 프로그램 아이콘을 누르면 사이드 패널(가사 화면)을 연다.
 * 가사·번역 데이터와 재생 정보는 다루지 않는다(모두 패널 페이지 안에서 처리).
 */
function enableActionPanel(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(enableActionPanel);
chrome.runtime.onStartup.addListener(enableActionPanel);
enableActionPanel();
