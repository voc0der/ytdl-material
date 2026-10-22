// A file's or playlist's short link, /s/<share_id>, which the server redirects to the player.
// It sits at the root beside the API, as the API itself does, so it is made from the API's
// address.
export function shareLink(api_path: string, share_id: string): string {
  return new URL(`../s/${encodeURIComponent(share_id)}`, new URL(api_path, document.baseURI)).href;
}

// The same link, opening at a time, in whole seconds.
export function shareLinkAt(link: string, seconds: number): string {
  const timed = new URL(link);
  const start = Math.floor(seconds);
  if (start > 0) timed.searchParams.set('t', `${start}`);
  return timed.href;
}

// The same link, playing only the part from one time to another, in whole seconds.
export function shareLinkBetween(link: string, start_seconds: number, end_seconds: number): string {
  const part = new URL(shareLinkAt(link, start_seconds));
  part.searchParams.set('end', `${Math.floor(end_seconds)}`);
  return part.href;
}
