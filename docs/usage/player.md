# Player and editing

Open a downloaded file or playlist from the library. The browser plays the saved media; codec support depends on your browser and the format you downloaded.

## Playback controls

- **Chapters:** use the chapter selector or timeline segments when chapter metadata is available.
- **Subtitles:** toggle saved subtitle tracks when the file has them.
- **Theater mode:** expands the viewing area and darkens the surrounding interface. Move over the toolbar area to reveal its controls.
- **Video blackout:** hides the picture while keeping playback available for listening.
- **Autoplay:** continues through the queue below the player. In a playlist it follows that collection; for an individual file it can load more from your library.
- **Repeat:** repeats playback; enabling Autoplay and Repeat changes the other mode so they do not compete.

Autoplay preference is remembered in your browser. The separate **Force autoplay** setting applies to the Home download flow's autoplay choice. Browsers may still require a user gesture before playing with sound.

The information dialog shows the file's metadata and available actions. Expand the description for longer source notes.

## Save a snip

A snip saves part of an existing file as a **new library item**, leaving the source intact.

1. Open the file's information dialog and choose **Snip**.
2. Set the beginning and end of the selection using the range controls.
3. Choose **Preview** to check the selection.
4. Select **Create snip** and wait for processing to finish.

Snipping requires a registered file, a known duration, and file-management permission. The result stays within the source's user or subscription storage area.

## Crop a new download

On **Home**, open the advanced download options and enable **Crop file**. Set **Crop from (seconds)** and **Crop to (seconds)** before downloading. The backend downloads and trims the result before registering it in the library; it does not keep a separate full-length library item for you.

Use **Snip** from the player when you already have a file and want to keep both the full recording and a shorter selection.

Video processing uses ffmpeg on the server. Administrators can enable [hardware acceleration](../deployment/hardware.md); the app checks the encoder and decoder and falls back to software when necessary.

## Other media tools

The player exposes downloading and sharing when permitted. SponsorBlock integration can provide a skip action when segment information is available and the integration is enabled. Twitch recordings can include a chat panel when chat was downloaded; enable automatic chat download in **Settings → Extra** if you want it for future recordings.

If playback fails while downloading the file to your computer works, check browser codec support before redownloading. A source's highest-quality format is not necessarily the most compatible browser format.
