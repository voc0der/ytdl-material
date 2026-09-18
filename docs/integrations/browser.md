# Browser extensions

The extension passes the current tab's URL to your ytdl-material frontend and can select audio-only downloading. It uses your browser's existing app session rather than a shared server API key.

## Chromium

1. Download the current [Chromium package](https://github.com/voc0der/ytdl-material/raw/main/chrome-extension/ytdl-material-chrome-extension.zip) and extract it, or clone the repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted directory containing `manifest.json` (or the repository's `chrome-extension` directory).
4. Open the extension's options, set **Frontend URL** to your instance, and save.
5. Sign into the app if it uses accounts, then open a supported source page and use the extension.

The Chromium build uses Manifest V3 and a service worker.

## Firefox

Use the [Firefox package](https://github.com/voc0der/ytdl-material/raw/main/chrome-extension/ytdl-material-firefox-extension.zip), which has its own Manifest V2 manifest and project-owned extension ID. The root `manifest.json` in the source tree is the Chromium version.

For local development, extract the Firefox package and load its manifest through `about:debugging` → **This Firefox** → **Load Temporary Add-on**. Temporary installation lasts for the browser session. Normal persistent Firefox installation requires a signed package; the repository ZIP alone does not establish that it has been signed. See [Mozilla's temporary-installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Older wiki links refer to a previous extension listing and Android collection. They are not installation instructions for the current repository package.

## When the icon is unavailable

The extension enables its action only on the source hostnames listed in its implementation; it is narrower than yt-dlp's full supported-site list. Paste other supported links directly into the app, or use the **Bookmarklet** under **Settings → Extra → Browser extensions**.

If clicking the icon opens the wrong instance, correct Frontend URL in the extension options. If it opens a login page, finish signing in before retrying the download.

## Build the packages

Contributors can regenerate both packages from source:

```bash
npm run package:extension
npm run test:extension
```

Packaging requires the `zip` command. `node chrome-extension/package.mjs --check` verifies the committed archives match the source.
