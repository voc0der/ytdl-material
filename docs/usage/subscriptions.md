# Subscriptions

A subscription checks a channel or playlist for eligible uploads and adds missing items to the download queue.

## Create a subscription

Open **Subscriptions**, paste the channel or playlist URL, and choose the download settings before subscribing. The app reads the source name and begins collecting eligible items. It also fetches the channel's avatar, or the playlist's cover, to show the subscription with, and refreshes it at most once a day as the subscription is checked.

| Setting | Behavior |
| --- | --- |
| Audio only | Creates an audio subscription; existing subscriptions cannot switch between audio and video |
| Quality | Sets the requested maximum video quality; defaults to Best |
| Time range | Downloads all eligible uploads, a preset recent period, or a custom number of days, weeks, months, or years |
| Use subfolder | Keeps the subscription in its own directory; enabled by default |
| Create playlist automatically | Maintains a library playlist for the subscription's downloaded files |
| Custom args / output | Overrides download details for this subscription |

A date range such as `now-2weeks` controls which uploads are eligible when a check runs. It does not delete older files that were already downloaded. Use the **Delete old files** task for retention.

A check with a date range first lists the source's uploads with their approximate dates, and fetches full details only for uploads near or inside the range, whose exact date decides. A short range on a large channel therefore takes seconds rather than one request per upload the channel has ever made.

The global **Skip join-only videos** option skips items identified as membership-only and records skipped subscription items in the Archive. If your access later changes, review that history before expecting those items to download. The optional **Redownload fresh uploads** setting requests later quality checks for recently published items; it is not a command to upgrade every existing file in a subscription.

## Check and schedule

Use a subscription's check action for an immediate refresh. For automatic checks, open **Tasks → Check subscriptions → Schedule**. A new installation seeds this task for **midnight each day in the server's timezone**. Schedules saved through the UI carry the browser's timezone.

There is no current subscription-check-interval environment setting. Change the task schedule instead.

The subscription page distinguishes checking the source from downloading the queued files. It also shows paused, failed, and unavailable states and the last completed check. A successful check may queue nothing because every matching item is already present or archived.

## Pause, stop, and edit

Pause a subscription to stop recurring collection while retaining its files and settings. Stop an active check when you need to interrupt the current refresh. Use **Downloads** to inspect individual queued or running jobs.

Open the subscription's settings to change quality, date range, folder behavior, playlist creation, and custom options. Changes affect subsequent work; they do not automatically reorganize every existing file on disk.

When automatic playlist creation is enabled, the app adds downloaded files without duplicating playlist entries. It waits until there are files before creating the playlist. Unsubscribing also cleans up the managed playlist and subscription references.

## Delete or unsubscribe

Read the removal dialog's choices carefully. Unsubscribing removes the subscription and its library records; retaining files on disk does not retain them as an active subscription in the library. Choosing to delete files also removes their stored media.

When deleting an individual subscription item, keeping it in the **Archive** prevents the next check from downloading it again. Removing its archive entry makes it eligible again if it still matches the subscription range.

[Archive behavior](archive.md) · [Task scheduling](tasks.md) · [Troubleshooting](../reference/troubleshooting.md)
