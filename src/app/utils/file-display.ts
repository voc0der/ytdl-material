interface ThumbnailSource {
  uid?: string;
  thumbnailPath?: string;
  thumbnailURL?: string;
}

/**
 * The image a row of files shows beside a title, the same one the library's card shows: the
 * thumbnail that was downloaded with the file, else the one the site had, else none.
 *
 * The endpoint takes the uid of the file, never its path -- a path says nothing about who owns
 * it -- and the token goes in the query, because an <img> cannot send a header. So does the
 * owner of a shared library the file is being shown from.
 */
export function fileThumbnailURL(file: ThumbnailSource | null | undefined, base_path: string, jwt: string | null = null, library: string | null = null): string | null {
  if (!file) return null;
  if (file.thumbnailPath && file.uid) {
    const base = base_path.endsWith('/') ? base_path.slice(0, -1) : base_path;
    const query = [
      jwt ? `jwt=${jwt}` : null,
      library ? `library=${encodeURIComponent(library)}` : null
    ].filter(Boolean).join('&');
    return `${base}/thumbnail/${encodeURIComponent(file.uid)}${query ? '?' + query : ''}`;
  }
  return file.thumbnailURL || null;
}

/** A duration as seconds. Older records hold it as the "4:03" the site printed. */
export function durationSeconds(duration: number | string | null | undefined): number {
  if (typeof duration === 'number') return Number.isFinite(duration) ? duration : 0;
  if (typeof duration !== 'string' || !duration) return 0;
  const parts = duration.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** "4:03", "1:02:09": how long a file runs, the way the library's cards say it. */
export function formatDuration(duration: number | string | null | undefined): string {
  const seconds = durationSeconds(duration);
  if (seconds <= 0) return '';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const padded_seconds = `${secs}`.padStart(2, '0');
  return hours > 0 ? `${hours}:${`${minutes}`.padStart(2, '0')}:${padded_seconds}` : `${minutes}:${padded_seconds}`;
}

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4',
  aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', flac: 'FLAC', alac: 'ALAC',
  ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', pcm: 'PCM'
};

/** "HEVC", "Opus": a codec the way people look it up, from the short name a record stores. */
export function codecLabel(codec: string | null | undefined): string | null {
  if (!codec) return null;
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}
