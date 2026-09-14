// How long the object URL outlives the click. Revoking it immediately can cancel the
// download before the browser has started reading the blob; 40 seconds matches what
// file-saver used.
export const OBJECT_URL_REVOKE_DELAY_MS = 40_000;

// Hands a blob fetched from the server to the browser as a file download.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}
