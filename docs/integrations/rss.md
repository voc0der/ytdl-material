# RSS feeds

RSS lists downloaded media from your library. Enable **Settings → Extra → RSS Feed**, then open **Generate RSS URL**.

## Build a feed

Choose a title filter, audio/video selection, subscription, favorites filter, sort order, and optional item limit. Copy the generated URL into your reader.

In multi-user mode, generate a **feed token** in the same dialog. Copy the token before closing; it is shown only once. Configure the reader to send:

```http
Authorization: Bearer <RSS_TOKEN>
```

The URL and token are separate. Feed readers must support custom Authorization headers to read a private feed directly. Tokens in query parameters are not supported.

## Test the feed

Set `YTDL_RSS_TOKEN` in your shell, then request the generated URL:

```bash
curl --fail-with-body 'https://media.example.com/api/rss' \
  -H "Authorization: Bearer ${YTDL_RSS_TOKEN}"
```

In single-user mode, an enabled feed requires no token. In multi-user mode, the authenticated account determines whose files appear; adding a `uid` parameter does not select another user's private library.

An RSS token is accepted only on `/api/rss`. It does not allow downloading new items or administering the app. Revoke it through **Your Profile** when a reader is removed. RSS and general API tokens share the 10-token account limit.

## Filters and links

The dialog handles URL encoding for fields such as text search and sort. Build a feed there before hand-editing parameters. The API also accepts category filters; see the [endpoint reference](api.md#endpoint-reference).

If the URL contains the wrong external port, replace its origin with your public HTTPS origin and check the [proxy limitation](../deployment/reverse-proxy.md#public-urls-and-oidc). Feed items link to the app's player. An RSS token does not automatically sign the reader's browser into private playback.

A `403` can mean RSS is disabled; a `401` in multi-user mode usually means the reader did not supply an accepted credential.
