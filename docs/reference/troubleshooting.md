# Troubleshooting

Start with the app version, downloader version, and relevant backend log. Reproduce with the same URL, format, account, and deployment settings that failed.

```bash
docker compose ps
docker compose logs --tail=200 ytdl-material
```

Use **Settings → Logs** or set `ytdl_log_level: 'debug'` temporarily for more detail. Remove credentials, tokens, and cookie contents before sharing logs.

## HTTP 403 while downloading

A source can reject media even after yt-dlp successfully reads its title and available formats. A failure in one format does not prove every other format fails.

1. Check the yt-dlp version and [update channel](../deployment/updates.md#update-yt-dlp). The app image's `latest` tag does not select nightly yt-dlp.
2. Remove stale global or subscription arguments that force an extractor client.
3. Leave **JavaScript runtimes** empty for auto-detection unless the named runtime is actually installed in the running container.
4. For authenticated media, upload current cookies and run the cookie test with the failing URL.
5. Inspect the debug argument log and reproduce the specific requested format.

Do not restore the retired fixed-client-fallback option. Upstream client behavior changes; start with yt-dlp's defaults and consult its [current extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors) before pinning a client yourself.

The normal managed downloader is kept under `appdata/bin`; an impersonation-enabled install may execute the Python package instead. Test the executable actually used by your configuration, rather than assuming an arbitrary `yt-dlp` on the host is the same version.

## HTTP 429 or too many requests

Distinguish an upstream rate limit in download logs from an HTTP 429 returned by your own `/api/` endpoint.

For upstream limits, pause affected subscriptions, wait, reduce concurrent downloads, add spacing between queued work, and use a less frequent **Check subscriptions** task schedule. No setting guarantees that a source will lift a block immediately.

For API limits, reduce client polling and inspect [proxy trust](../deployment/reverse-proxy.md#trust-and-access-restrictions). A misconfigured proxy can make every user appear to share one client address. Redis affects the app's limiter; it does not remove upstream limits.

## The app is running but unreachable

- Confirm the host-to-container port mapping and listening port match.
- Test the published port from the host before testing the reverse proxy.
- Check the host firewall, especially DSM profiles on Synology.
- Check `ytdl_reverse_proxy_whitelist`; it restricts direct peers.
- Check database and OIDC initialization logs if the app is restarting before it listens.

## Permissions or files disappearing

Verify the app's UID/GID, mount ownership, and available disk space. A container started with `user:` cannot fix ownership or install required system packages on its own. Custom output paths must be mounted persistently.

If records remain but playback reports a missing file, check that the media disk is mounted at its original container path. Do this before confirming **Missing files check** results.

## Empty library after an upgrade

Check **Settings → Database** for the active engine. A new Compose file may select PostgreSQL while the existing records remain in MongoDB. Confirm the original `appdata` and media directories are mounted, then inspect [migration](../deployment/migration.md).

After enabling multi-user mode, unowned single-user files are not automatically every user's library. Review [ownership assignment](../deployment/authentication.md#assign-unowned-media) rather than redownloading the entire collection.

## Subscriptions are not downloading

Check whether the subscription is paused, the selected date range excludes the items, or matching items are already present in its Archive. Inspect **Tasks → Check subscriptions** for its schedule and pending/running state. An individual refresh can finish before its queued downloads complete.

## Login or API access fails

For OIDC, verify issuer discovery, exact redirect URI, client secret, scopes, group claims, and automatic registration. Restarting during a login exchange discards its pending state; begin a fresh login afterward.

For LDAP, a service-account bind failure affects every user. Also check search base, filter, and the returned `uid`.

For scripts, send a [Bearer token](../integrations/api.md) in the Authorization header. The old shared key and query-token patterns are retired. An RSS token works only on the feed endpoint.

## GPU option is enabled but processing uses CPU

Read the encoder/decoder check results in **Settings → Downloader** and the server log. Confirm GPU devices, supplementary group IDs, host drivers, and container dependencies. VAAPI/QSV may need a restart after their first selection. See [hardware acceleration](../deployment/hardware.md).

## Settings revert after restart

Look for the same setting in the container environment. Startup reapplies those values. Removing a variable leaves its last saved value; explicitly clear or change it in the saved configuration when appropriate.
