# MCP server

An MCP client, such as a desktop chat app or an agent, can search your library and manage downloads through [`mcp-server/ytdl_material_mcp.py`](https://github.com/voc0der/ytdl-material/blob/main/mcp-server/ytdl_material_mcp.py). It is a single file that runs next to the client, over stdio, and calls your instance's [API](api.md) as one account.

## Tools

| Tool | What it does |
| --- | --- |
| `search_library` | Searches titles, or lists the most recently added items. Each result links to its player. |
| `list_downloads` | Lists downloads, newest first, with their state and progress, and a player link once finished. |
| `start_download` | Queues a URL as video or audio. It returns once queued, not once downloaded. |
| `pause_download`, `resume_download`, `cancel_download` | Act on one download, named by the uid `list_downloads` gives. |

The listing tools are marked read only and `cancel_download` destructive, for clients that ask before acting. The server does not delete, edit, or share anything, change settings, or read other accounts' shared libraries.

## Requirements

- [uv](https://docs.astral.sh/uv/). The script declares its dependencies (the MCP Python SDK and httpx), and uv installs them on first run.
- In multi-user mode, an [API token](api.md#create-a-token) for the account the client should act as. Give each client its own token, so one can be revoked without the others.
- For `list_downloads` and the pause, resume and cancel tools, the **Use downloads manager** permission. The default `user` role does not have it; grant it to the role or the account under **Settings → Users**. Searching and starting downloads need no extra permission.

## Configure a client

Download the script:

```bash
curl -fLo ytdl_material_mcp.py https://raw.githubusercontent.com/voc0der/ytdl-material/main/mcp-server/ytdl_material_mcp.py
```

Then add it to the client's MCP servers. Most clients take this shape:

```json
{
  "mcpServers": {
    "ytdl-material": {
      "command": "uv",
      "args": ["run", "--script", "/path/to/ytdl_material_mcp.py"],
      "env": {
        "YTDL_URL": "https://media.example.com",
        "YTDL_API_TOKEN": "<API_TOKEN>"
      }
    }
  }
}
```

| Variable | Meaning |
| --- | --- |
| `YTDL_URL` | Where the API answers, with the scheme and any port, for example `http://localhost:17442`. |
| `YTDL_API_TOKEN` | The account's API token. Leave it out in single-user mode. |
| `YTDL_PUBLIC_URL` | The address to use in links it returns, when that is not `YTDL_URL`: for example when the client reaches the API on `localhost` but you open the app at `https://media.example.com`. |

For an instance behind a private certificate authority, add `SSL_CERT_FILE` with the path to its CA bundle to the same `env` block.

The token is an ordinary API token. Whoever can read the client's configuration can use the whole API as that account, not only these tools.

## Troubleshooting

A setting the server cannot use stops it at start with a message on stderr, which most clients show in their MCP log. Everything else comes back as a tool error the model can read:

| Tool error | What to check |
| --- | --- |
| `refused the API token` | The token was revoked, mistyped, or made on another instance. |
| `needs an API token` | The instance is in multi-user mode; set `YTDL_API_TOKEN`. |
| `Missing the 'downloads_manager' permission` | Grant **Use downloads manager** to the account. |
| `Could not reach ytdl-material` | `YTDL_URL`, and that the client's machine can reach it. |
| `HTTP 301` or `HTTP 308` | `YTDL_URL` points at a redirect, usually `http://` where the proxy serves `https://`. |
| `did not answer with JSON` | `YTDL_URL` reaches something other than the API, such as a proxy's sign-in page. The server sends only the API token; it cannot sign in to a proxy. |
| `rate limiting this client` | The app's [request limiter](api.md#migrating-old-clients); wait a minute. |
