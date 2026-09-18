# API and tokens

The backend exposes its API under `/api/`. In multi-user mode, scripts authenticate as a specific account and inherit that account's permissions and ownership restrictions.

## Create a token

1. Sign in and open **Your Profile**.
2. Generate an API token with a label identifying the script or app using it.
3. Copy the value immediately; it is shown only once.
4. Send it in **`Authorization: Bearer <token>`** on API requests.

Revoke unused or exposed tokens from your profile. There is a combined limit of **10 API and RSS tokens per account**. Deleting the account invalidates its tokens. A token cannot mint or revoke other tokens; token management requires an interactive login session.

Single-user mode does not require a credential and does not issue these tokens. Network access to a single-user instance grants access to its API.

## Examples

Set `YTDL_API_TOKEN` in your shell to your token. Replace the sample media URL with a real supported URL:

```bash
curl --fail-with-body -X POST 'https://media.example.com/api/tomp4' \
  -H "Authorization: Bearer ${YTDL_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/media-page"}'
```

For audio, use `/api/tomp3`. To list the video library:

```bash
curl --fail-with-body -X POST 'https://media.example.com/api/getMp4s' \
  -H "Authorization: Bearer ${YTDL_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
```

The account must have the permissions required by each endpoint. A valid token does not bypass those checks.

## Endpoint reference

Enable API documentation under **Settings → Extra**, or set `ytdl_enable_documentation_api: 'true'`, and **restart**. Your instance serves the interactive reference at `/docs` and its OpenAPI document at `/openapi.yaml`.

The repository's [OpenAPI specification](https://github.com/voc0der/ytdl-material/blob/main/Public%20API%20v1.yaml) describes request bodies and responses, including media streaming and subtitle endpoints. Check the reference matching your running version before building against an endpoint.

## Migrating old clients

The old shared API key and `?apiKey=...` authentication are retired. Remove that query parameter and configure a Bearer token for the intended user. Do not substitute `?token=...` or an RSS token for ordinary API authentication.

| Response | What to check |
| --- | --- |
| `401` | Missing, malformed, revoked, or invalid token; verify the proxy forwards Authorization |
| `403` | Account permission, administrator requirement, or endpoint-specific restriction |
| `404` at `/docs` | API documentation disabled, missing spec, or restart still required |
| `429` | The app's request limiter; reduce request frequency and inspect proxy trust configuration |

Browser share links authorize only the shared file or playlist routes. They are not general API credentials.
