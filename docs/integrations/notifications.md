# Notifications and webhooks

Open **Settings → Notifications**, enable notifications, and choose all event types or a selected set. In-app notifications are available from the notification bell.

| Event | Included information |
| --- | --- |
| `download_complete` | File title, original URL, app link, and thumbnail when available |
| `download_error` | Source URL and error details |
| `task_finished` | Task title and completion information |

Routine subscription checks suppress task-finished notifications, so a successful scheduled check need not produce an alert.

## Connect a service

| Service | Configure in ytdl-material |
| --- | --- |
| Discord | Incoming webhook URL for a channel |
| Slack | Incoming webhook URL for your workspace/channel |
| Telegram | Bot token and target chat ID |
| Gotify | Server URL and application token |
| ntfy | Full topic URL |
| Custom webhook | URL receiving JSON POST requests |

Save the settings and verify delivery with an actual event of an enabled type. Check backend logs if delivery fails. The service endpoint must be reachable from the **server**, not just from the browser displaying Settings.

Telegram's webhook-proxy option concerns incoming bot requests; basic outgoing notifications use the bot token and chat ID. Incoming requests require the configured webhook secret. Keep these values in server configuration rather than public examples.

## Custom webhook payload

The default JSON shape is:

```json
{
  "body": "A download has completed.",
  "title": "Download complete",
  "type": "download_complete",
  "url": "https://media.example.com/#/player;uid=FILE_ID",
  "thumbnail": null
}
```

Actual message text and optional values depend on the event. Do not assume every event has a thumbnail or file title.

## Customize title and body

Enable the custom webhook template option and open the template editor. Templates replace `{{placeholder}}` expressions with event values. For example:

```text
{{event_name}}: {{video_name}}
```

```text
{{event_body}}
Source: {{video_original_url}}
Open: {{notification_url}}
```

Available values include `event_name`, `event_type`, `event_body`, `video_name`, `video_original_url`, `notification_url`, `notification_thumbnail`, `task_name`, `error_message`, `error_type`, `notification_uid`, and `timestamp`. Raw event data is available through dotted paths under `data`. Missing values become empty strings.

Templates replace the payload's title and body; they do not define arbitrary HTTP headers or a completely different JSON schema. For a service requiring another request format, transform the payload in an intermediary webhook service.

If an alert arrives but its app link is wrong, inspect the configured URL and [proxy port behavior](../deployment/reverse-proxy.md#public-urls-and-oidc).
