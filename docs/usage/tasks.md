# Tasks and schedules

Open **Tasks** for maintenance and recurring work. Each task shows its current state, last result, and schedule. Access requires the `tasks_manager` permission in multi-user mode; database administration operations also have administrator restrictions.

## Available tasks

| Task | What it does |
| --- | --- |
| Backup DB | Writes a snapshot of the active database to `appdata/db_backup` |
| Missing files check | Finds database records whose files are absent from disk; review before removing records |
| Import missing DB records | Registers supported media found in managed directories |
| Find duplicate files in DB | Finds duplicate entries for review and removal |
| Update yt-dlp | Checks the selected downloader for an update and offers to apply it; the title names the downloader chosen in **Settings → Advanced** |
| Delete old files | Finds files older than the configured retention threshold, in the whole library or only from subscriptions; confirmation deletes them |
| Import legacy archives | Imports older archive and blacklist text files into the database |
| Rebuild database | Backs up the database and rebuilds file records from stored media and metadata |
| Apply categories to existing files | Re-evaluates category membership using current rules |
| Check subscriptions | Checks active subscriptions and queues eligible missing items |
| Delete old playback transcodes | Deletes copies made for transcoding playback links once they are over six hours old and no unexpired link, queued or running transcode uses them |
| Codec discovery | Records the video and audio codec of files that have none; with a preferred codec set, converts other videos to it. See [codec discovery](#codec-discovery) |
| Auto-transcribe | Has the local AI model write up library audio and video in the style set in its options, with what is on screen when Vision is on, and saves it in metadata sidecars. Visible when AI integration is enabled; see [local AI transcription](#local-ai-transcription) |
| Fix audio sync after SponsorBlock cuts | Puts the audio back in sync in videos where it runs late after a SponsorBlock cut, without re-encoding. New downloads are fixed as they finish; this fixes older ones. Only MP4, M4V, MOV and WebM files are rewritten |

## Run and review

Choose **Run** to execute a task. Some tasks finish immediately; others leave findings that need a second action, such as removing missing records, deleting old files, or installing a downloader update. Review the count and result before selecting that action.

The **Auto confirm** option applies a task's findings without manual review. Leave it disabled until you have run the task and verified its selection, especially for retention and duplicate removal. A disconnected media mount can make many existing files appear missing.

## Schedule a task

Open the task's schedule dialog and select a one-time or recurring schedule. The UI saves the browser's timezone; recurring tasks use that timezone when calculating their next run. Old schedules without a timezone use server time. If a timezone is invalid, the server logs a warning and falls back to its local timezone; resave the schedule to correct it.

The default **Check subscriptions** and **Delete old playback transcodes** schedules run daily at midnight in server time. An unset recurring field means every value of that field: leaving the minute unspecified can run a task every minute during the selected hour. Select both hour and minute for a once-daily schedule.

A task that is already running or waiting for confirmation is skipped at its next scheduled invocation. Complete or dismiss pending work if the schedule appears to stop running.

## Codec discovery

Every run probes library files whose records have no codec yet and stores it. New downloads record their codec as they finish, so this mostly catches up files from before the feature existed. The codec shows as a badge in the file's **Info** dialog, including from the player.

With a **Preferred codec** set in **Settings → Downloader** (`ytdl_preferred_codec`: `h264`, `hevc`, `av1` or `vp9`), the run then converts every other video, one at a time:

1. If the file has a source URL and the source offers the codec at the file's resolution or better, it is downloaded again in that format, with the same audio format as before when that is still offered.
2. Otherwise it is transcoded, on the GPU when [hardware acceleration](../deployment/hardware.md) is set up and its encoder for that codec passes a flight test, on the CPU otherwise.

A file is never downloaded again if it runs shorter than its source, since it was trimmed, snipped or had SponsorBlock segments cut after download; it is transcoded instead. HDR video is left as it is, because converting it without tone mapping would flatten it to SDR. A container that cannot hold the codec is replaced with MP4, for example a VP9 `.webm` converted to HEVC becomes `.mp4`. Every converted file is checked for codec, length and audio before it replaces the original. Transcoding from H.264 loses less than transcoding from AV1 or VP9, which also tend to come out larger.

New downloads also prefer the codec when the source offers it at the best available resolution, so they rarely need converting later.

Task options:

- **Convert to the preferred codec**: turn off to only record codecs, even with a preferred codec set.
- **Conversions per run**: stops after this many files, counting downloads and transcodes. `0`, the default, means no limit. The rest wait for the next run. Files that failed before go last, so they cannot use up a limited run.

A run can take hours on a large library. It keeps going after the Tasks page is closed, and a second run started meanwhile does not start another conversion. A file that fails keeps its original, and the reason is in the log. Converted files replace the originals, so take a [backup](../deployment/backups.md) of media you cannot download again before the first run.

If the container stops during a conversion, the next start discards the unfinished copy and keeps the original, or finishes deleting the original if the new file had already been saved. The task is left idle; nothing resumes on its own. Work files live beside each original as `*.codec-part` and under `appdata/codec-work`, which lite server backups skip.

## Local AI transcription

AI integration is off by default. Enable it in **Settings → Advanced → Local AI** and enter the **Server URL** of any OpenAI-compatible server, such as llama.cpp, llama-swap, Ollama or LM Studio. The URL works with or without `/v1`. Add the **API key** if the server needs one; it is saved on the app server and hidden from other accounts. **Connect** saves the URL and key, and only those, then lists the server's models to choose one under **Model**; the app only ever contacts the saved server. When the server cannot be asked, the page says why, such as a refused key, nothing listening at that address or the server's own error, and the server log has the same line. A saved server's models are listed again whenever the page opens.

Use a URL reachable from the app server, such as `http://ollama:11434` on a shared Docker network or `http://192.168.1.20:8080` on another machine. `localhost` inside the app container refers to that container. Loopback, private IPv4, private IPv6, and Tailscale addresses are accepted, including hostnames that resolve only to them; public addresses, HTTP redirects, and environment HTTP proxies are not used. Ollama's cloud models are left out of the list. Only self-hosted services are supported. The operator is responsible for keeping those services local; the app cannot inspect what a reverse proxy forwards to.

Then turn on what the chosen model can do:

- **Audio**: it can hear sound. Auto-transcribe needs this to write up speech.
- **Vision**: it can see images. Auto-transcribe needs this for visual cues.

The app does not test what a model can do, and goes by these switches. A model sent sound or images it cannot take fails the task, with the server's reason in the log.

After saving, open **Tasks → Auto-transcribe** to choose how it writes, then run it or set a schedule. Enabling AI does not start work or create a schedule. Its options:

- **Speech**: how the model writes up what is said. **Exact** is word for word, **Brief** a sentence or two for each half minute, **Detailed** notes on every point, **Descriptive** word for word with music, laughter and other sounds described in brackets, and **Novel** retells it as a story, with dialogue.
- **Visual cues**: offered when Vision is on. **Off**, or the same five styles for what the frames show: on-screen text and what is visible, stated plainly (**Exact**), only what matters most (**Brief**), what helps follow along (**Detailed**), people, places and mood (**Descriptive**), or woven in as scenery (**Novel**). A video with no sound is described from its frames alone.
- **Files per run**: 1–1000, 10 by default. Failed attempts count toward the limit and are retried after files that have not failed.

The task goes through each file 30 seconds at a time. For each stretch it uses ffmpeg to take the first audio track as mono 16 kHz WAV and, with visual cues, three frames at most 768 pixels on a side, and sends them to the model in one chat request, with the end of the text so far so the model carries on from it. It works on one file at a time, with a ten-minute timeout per stretch, long enough for a server that loads the model first. Temporary audio and frames are removed when the attempt finishes. Nothing downloads a model or falls back to a hosted service.

What the model writes is merged into `ytdl_material.transcript` in the existing `.info.json` sidecar, including older extension-bearing filenames. If no sidecar exists, one is created. The record includes the text, each stretch's offsets in seconds, the model, the speech and visual cue styles, the creation time, and the media's size and modification time. Offsets are not word or subtitle timestamps. Other metadata is retained, malformed sidecars are left untouched, and a failed or incomplete write-up never replaces a saved one. A file is done again on a later run when its size or modification time changes, or when the model or a style changes. Files with nothing to send the model are skipped: no sound with Audio off, and no picture or visual cues off. The card reports completed, skipped, and failed counts; failures include the reason in the server log. Existing task permissions govern access to this library-wide task.

Open a file's **Info** dialog to read what the model wrote, titled by style: Transcript, Summary, Notes, Story or Description. It is served through the existing file access checks. AI output can contain mistakes. Disabling AI stops active work, hides the task, and prevents scheduled runs from contacting the server; saved write-ups remain readable, and the schedule is kept for when AI is enabled again. Completed files are kept if a run is interrupted; an unfinished file starts again on the next run. Include media sidecars in backups to retain them.

## Retention

Set the age threshold for **Delete old files** in its options. Age is measured from when a file was **registered in the library**, not its source upload date.

Without **Subscription files only**, the task deletes every file in the library past that age, however it was downloaded. With it on, the task deletes only files a subscription downloaded and keeps each in its subscription's archive, so the next check does not download it again. **Blacklist what it deletes** archives everything the task deletes; for files from outside subscriptions that only matters with download archiving on.

Database snapshots do not include media files. Follow [backups and restore](../deployment/backups.md) before using rebuild, retention, or bulk cleanup.
