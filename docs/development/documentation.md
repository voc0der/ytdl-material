# Maintaining the docs

The site uses [Zensical](https://zensical.org/docs/) with Markdown sources under `docs/` and navigation in `mkdocs.yml`. The dependency is pinned in `requirements-docs.txt`. It builds independently of the application.

## Preview locally

With Python 3.10 or later:

```bash
python3 -m venv .venv-docs
.venv-docs/bin/python -m pip install -r requirements-docs.txt
.venv-docs/bin/zensical serve
```

Open the local address printed by the server. On Windows, use the equivalent commands under `.venv-docs/Scripts`.

If you use uv, the same pinned requirements can run without managing a virtual environment:

```bash
uv run --with-requirements requirements-docs.txt zensical serve
```

## Verify before submitting

```bash
node dev/docs/config-reference.mjs --check
.venv-docs/bin/zensical build --clean --strict
python3 dev/docs/check-site.py
```

The build fails on warnings. The link check inspects generated pages, anchors, and assets, including paths under `/ytdl-material/`. It does not check external websites or validate live database, identity-provider, or GPU deployments.

The complete configuration table is generated from backend source constants, without reading local configuration or running the app. After changing the registry or defaults, regenerate it and commit the result:

```bash
node dev/docs/config-reference.mjs
```

## Publish on GitHub Pages

In repository **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. The Documentation workflow validates pull requests and deploys successful documentation builds from `main` to:

```text
https://voc0der.github.io/ytdl-material/
```

Manual workflow runs also deploy only when run on `main`. Pull requests have read-only repository permission and cannot deploy. The deployment job uses the `github-pages` environment and Pages/OIDC permissions; it does not need a personal access token. This follows the [GitHub Pages workflow model](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Build output (`site/`), caches, and the local Python environment are ignored. Commit sources and configuration, not the generated HTML.

## Keep guidance current

Document observable behavior and the actual UI labels. Check backend behavior when a setting's label or an older guide is ambiguous. Add new pages to navigation, use relative Markdown links for other guides, and give code examples realistic placeholders.

Keep the [audit](audit.md) updated when resolving an explicitly recorded limitation. For app features added after the current documentation baseline, update the appropriate guide along with the code rather than waiting for a separate wiki cleanup.
