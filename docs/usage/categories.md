# Categories

Categories organize media by rules applied to its metadata. They are configured under **Settings → Downloader → Categories** and are shared across the server. Category views still respect ownership in multi-user mode.

## Filter your library by category

Turn on **Show as library filter** when you create or edit a category, and it appears as a filter on the home page next to **Video only**, **Audio only**, and **Favorited**. Turn it on there to see only the files in that category. On a phone, the filters are under the filter button in the search field.

## Create a rule

Create or edit a category, then choose a metadata property, comparison, and value. Combine additional rules with **AND** or **OR**.

For example, an Education category could match a title containing `lecture` or source categories containing `Education`. Rules depend on the metadata the extractor returns; test with files you already have before using a category to route downloads.

Built-in templates cover common subjects such as Music, Technology, Education, News, and Gaming. Treat them as starting points: an uploader or title match may be broader than your intended collection. The first matching category wins, so put specific rules ahead of broad ones.

## Filenames and category views

A category can define a custom output template using yt-dlp fields, for example:

```text
education/%(uploader)s/%(title)s
```

The app appends the extension. Keep the template relative to the download folder: current code rejects absolute custom output paths and paths that escape that folder. To place a library on another disk, mount that disk at the configured media root rather than using a category template to escape it. This replaces the old wiki's claim that category output can point anywhere on the filesystem.

With playlist categorization enabled, categories containing files appear as category playlists. Library and RSS filtering also support category membership.

## Apply new rules to existing files

Run **Tasks → Apply categories to existing files** after changing your rules. It recalculates category membership from stored metadata. It does not move or rename existing media to match a new output template.

Subscription downloads have their own folder and output controls. Use those controls for subscription storage rather than assuming a category's one-off download template will relocate a subscription.

Keep **Include metadata** enabled when downloading. More complete metadata makes rules and later reclassification more useful.
