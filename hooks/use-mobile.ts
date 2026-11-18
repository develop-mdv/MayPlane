import { useSyncExternalStore } from 'react';

const compactView =
  '(max-width: 767px), (max-width: 950px) and (max-height: 500px)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(compactView);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function isMobile() {
  return window.matchMedia(compactView).matches;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobile, () => false);
}
