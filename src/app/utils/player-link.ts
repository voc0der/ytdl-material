import type { DatabaseFile, Playlist } from '../../api-types';

export const PLAYER_KEYS = ['v', 'list', 'uid', 'playlist_id', 'sub_id'] as const;

export function isPlayerRoute(url: string): boolean {
  const parsed = new URL(url, 'http://local');
  return parsed.pathname === '/' && PLAYER_KEYS.some(key => parsed.searchParams.has(key));
}

export function isPublicPlayerRoute(url: string): boolean {
  return isPlayerRoute(url) && new URL(url, 'http://local').searchParams.has('uuid');
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
    commands: ['/'],
    queryParams: {[playlist ? 'list' : 'v']: record.share_id, ...params}
  };
  // Automatic category playlists and older records may not have a short id.
  return {
    commands: ['/'],
    queryParams: {...params, [playlist ? 'playlist_id' : 'uid']: playlist ? record.id : (record as DatabaseFile).uid}
  };
}

// window.open copies the opener's session storage into the new tab. Hand off this one
// queue without putting it in the link, then remove the handoff from the original tab.
export function openPlayerTab(route: string, queue: Record<string, string> = {}): void {
  const url = new URL(route.slice(1) || './', document.baseURI).href;
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
