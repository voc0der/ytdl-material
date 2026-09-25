# Library and playlists

The library contains files registered with ytdl-material. It is separate from **Downloads**, which tracks the jobs that produced them, and from **Archive**, which records source items that should be skipped on future downloads.

## Find a file

Use the search field, media-type filter, favorites, and category filters to narrow the library. Sorting by **Upload Date** follows the source publication date; sorting by the date added to the library follows when the app registered it. Older imports may have less metadata than new downloads.

Use the pagination footer to change pages and page size. Open a card to play the item, or use its menu for details, favorites, playlists, downloading, sharing, or removal. Available actions depend on your permissions and whether the entry represents a file or a playlist.

## Create and edit playlists

1. Choose **New playlist** from the library controls.
2. Name the playlist and select the files you want to include.
3. Save it, then open it from the library to play the collection.

Use **Add to playlist** on a file to add it to an existing collection. Editing a playlist changes its membership; removing a file from that playlist does not itself delete the media from disk.

Subscriptions can maintain their own playlists automatically. Enable **Create playlist automatically** in that subscription's settings. The playlist is created when there are downloaded files to include, and later downloads are added to it. See [subscriptions](subscriptions.md).

## Download a collection to your computer

Playlist and subscription download actions prepare an archive for your browser. Confirm the operation and follow the progress dialog; you can cancel while it is being prepared. Large collections need processing time and temporary disk space on the server.

## Share media

Use **Share** on a file or playlist to enable sharing and copy its link. In multi-user mode, a share authorizes access to the selected media; it does not grant access to the owner's whole library or administrative actions. Disable sharing to withdraw access.

Recipients still need a reachable server address. Test the link outside your signed-in session, and use a [reverse proxy](../deployment/reverse-proxy.md) when sharing beyond your local network.

## Share your whole library

In multi-user mode, turn on **Share library** under **Profile → Preferences** to let every other account on the server browse and watch your library. They cannot change anything in it: no favorites, edits, cover art, playlists, deletions or downloads to their device, and watching does not add to your view counts. Turn it off to withdraw access at once.

Once someone shares their library, your name at the top of **Profile** becomes a menu. Pick their name to browse their files and playlists on the home page; each file's menu then offers only **Media info**. While you browse someone else's library, a button left of the notification bell takes you back to yours in one press. Pages that only ever show your own things, such as Subscriptions, Downloads, Duplicates and Archive, are put away meanwhile, and opening one from a link or bookmark takes you back to your own library first. Downloads you start meanwhile still go to your own library, and reloading the page or signing in again starts on your own.

## Import existing files

Place files in the configured media directories, keeping their `.info.json` metadata alongside them when available. Run **Tasks → Import missing DB records** to register media the app does not know about. Inspect the results before assuming a copied directory is fully imported.

If files were moved or removed outside the app, **Missing files check** finds records whose paths no longer exist. Review those findings carefully: an unavailable mount can look like deleted files. See [tasks](tasks.md).
