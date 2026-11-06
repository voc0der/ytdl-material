import type { DatabaseFile, Playlist } from '../../api-types';

export function compactPlayerPath(pathname: string, search = ''): string | null {
  const match = pathname.match(/\/(video|audio|playlist)$/);
  return match ? `/${match[1]}${search}` : null;
}

export function isPlayerRoute(url: string): boolean {
  return /^\/(player|video|audio|playlist)([;/?]|$)/.test(url);
}

// Queue preferences belong to this browser history entry, not to a copied player link.
export const PLAYER_QUEUE_STATE = 'playerQueue';
const NEW_TAB_QUEUE = 'playerQueueForNewTab';
export const PLAYER_QUEUE_PARAMS = [
  'queue_sort_by', 'queue_sort_order', 'queue_file_type_filter', 'queue_favorite_filter',
  'queue_category_filter_uids', 'queue_search', 'queue_sub_id'
] as const;

export function playerLink(record: DatabaseFile | Playlist, playlist = false, params: Record<string, string> = {}) {
  if (record.share_id) return {
    commands: [playlist ? '/playlist' : (record as DatabaseFile).isAudio ? '/audio' : '/video'],
    queryParams: {id: record.share_id, ...params}
  };
  // Automatic category playlists and older records may not have a short id.
  return {
    commands: ['/player', {...params, [playlist ? 'playlist_id' : 'uid']: playlist ? record.id : (record as DatabaseFile).uid}],
    queryParams: {}
  };
}

// window.open copies the opener's session storage into the new tab. Hand off this one
// queue without putting it in the link, then remove the handoff from the original tab.
export function openPlayerTab(route: string, queue: Record<string, string> = {}): void {
  const path = /^\/(video|audio|playlist)(\?|$)/.test(route) ? route.slice(1) : '#' + route;
  const url = new URL(path, document.baseURI).href;
  try {
    sessionStorage.setItem(NEW_TAB_QUEUE, JSON.stringify({url, queue}));
  } catch { /* Playback still opens with its default queue if storage is unavailable. */ }
  try {
    window.open(url);
  } finally {
    try { sessionStorage.removeItem(NEW_TAB_QUEUE); } catch { /* Storage may be disabled. */ }
  }
}

export function takePlayerTabQueue(): Record<string, string> | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(NEW_TAB_QUEUE) || 'null');
    sessionStorage.removeItem(NEW_TAB_QUEUE);
    return saved?.url === window.location.href ? saved.queue : undefined;
  } catch {
    return undefined;
  }
}
