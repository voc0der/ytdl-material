#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=2.2,<3", "httpx"]
# ///
"""MCP server for one account on a ytdl-material instance.

Gives an MCP client six tools: search the library, list downloads, start a download, and
pause, resume or cancel one. It calls the instance's API as the account whose token it is
given, so it can see and do what that account can in the app, and nothing more.

It is configured from the environment:

    YTDL_URL          Where the API answers, e.g. http://localhost:17442
    YTDL_API_TOKEN    An API token from Your Profile. Multi-user mode only.
    YTDL_PUBLIC_URL   The address to put in links it hands back, when that is not YTDL_URL.

uv installs the dependencies above on first run:

    uv run --script ytdl_material_mcp.py

Client configuration is in docs/integrations/mcp.md.
"""

import logging
import os
import sys
from datetime import datetime, timezone
from typing import Annotated, Literal
from urllib.parse import quote, urlsplit

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field


def read_origin(name, value):
    value = value.strip().rstrip("/")
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        sys.exit(f"{name} must be an http(s) address such as http://localhost:17442, not {value!r}")
    return value


# The SDK logs at INFO, which would put a line in the client's MCP log for every API request.
logging.getLogger("httpx").setLevel(logging.WARNING)

API_URL = read_origin("YTDL_URL", os.environ.get("YTDL_URL", ""))
PUBLIC_URL = read_origin("YTDL_PUBLIC_URL", os.environ.get("YTDL_PUBLIC_URL") or API_URL)
API_TOKEN = os.environ.get("YTDL_API_TOKEN", "").strip()

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

mcp = MCPServer(
    name="ytdl-material",
    instructions=(
        "Tools for one account's ytdl-material library and downloads. search_library finds "
        "downloaded media and gives a player link for each item. start_download queues a URL "
        "and returns at once; follow it with list_downloads, which gives a player link once "
        "a download has finished. A download_uid names a download, not a library item: use it "
        "only with the download tools."
    ),
)


async def call(route, body):
    headers = {"Accept": "application/json"}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{API_URL}/api/{route}", json=body, headers=headers)
    except httpx.HTTPError as error:
        raise ToolError(f"Could not reach ytdl-material at {API_URL}: {error}") from None

    try:
        result = response.json()
    except ValueError:
        result = None
    reason = result.get("error") if isinstance(result, dict) else None

    if response.status_code == 401:
        if API_TOKEN:
            raise ToolError("ytdl-material refused the API token: it is invalid, revoked, or for another instance.")
        raise ToolError("ytdl-material is in multi-user mode and needs an API token. Set YTDL_API_TOKEN.")
    if response.status_code == 403:
        raise ToolError(
            f"ytdl-material refused this: {reason or 'forbidden'}. "
            "An administrator can grant account permissions under Settings → Users."
        )
    if response.status_code == 429:
        raise ToolError("ytdl-material is rate limiting this client. Wait a minute and try again.")
    if response.status_code != 200:
        detail = f": {reason}" if reason else ""
        raise ToolError(f"ytdl-material answered {route} with HTTP {response.status_code}{detail}")
    if not isinstance(result, dict):
        raise ToolError(
            f"ytdl-material did not answer with JSON at {API_URL}/api/{route}. YTDL_URL may reach "
            "something other than the API, such as a proxy's sign-in page."
        )
    return result


def player_link(**params):
    matrix = "".join(f";{key}={quote(str(value), safe='')}" for key, value in params.items())
    return f"{PUBLIC_URL}/#/player{matrix}"


def timestamp(ms):
    if not isinstance(ms, (int, float)) or ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def present_file(item):
    uid = str(item.get("uid") or "")
    return {
        "uid": uid,
        "title": item.get("title"),
        "uploader": item.get("uploader"),
        "type": "audio" if item.get("isAudio") else "video",
        "duration_seconds": item.get("duration"),
        "size_bytes": item.get("size"),
        "uploaded": item.get("upload_date"),
        "added": timestamp(item.get("registered")),
        "favorite": bool(item.get("favorite")),
        "link": player_link(uid=uid) if uid else None,
    }


# The same reading of a download's flags as the Downloads page.
def download_state(item):
    cancelled = bool(item.get("cancelled")) or item.get("error_type") == "cancelled"
    if item.get("error") and not cancelled:
        return "failed"
    if cancelled:
        return "cancelled"
    if item.get("finished"):
        return "finished"
    if item.get("paused"):
        return "paused"
    # step_index 0 is a download the queue has not picked up yet.
    try:
        return "running" if int(item.get("step_index") or 0) > 0 else "queued"
    except (TypeError, ValueError):
        return "queued"


def present_download(item):
    state = download_state(item)
    result = {
        "download_uid": item.get("uid"),
        "title": item.get("title"),
        "type": item.get("type"),
        "state": state,
        "percent_complete": item.get("percent_complete"),
        "started": timestamp(item.get("timestamp_start")),
        "source_url": item.get("url"),
    }
    if state == "failed":
        result["error"] = item.get("error")

    # What a finished download made: one file, or a playlist of them. A file record also
    # carries an id (the site's), so uid has to be checked first.
    container = item.get("container")
    if state == "finished" and isinstance(container, dict):
        if container.get("uid"):
            result["link"] = player_link(uid=container["uid"])
        elif container.get("id"):
            result["link"] = player_link(playlist_id=container["id"])
    return result


@mcp.tool(annotations=READ_ONLY)
async def search_library(
    query: Annotated[str, Field(description="Words to find in titles. Empty lists the most recently added.")] = "",
    media_type: Literal["any", "audio", "video"] = "any",
    favorites_only: bool = False,
    limit: Annotated[int, Field(ge=1, le=25)] = 10,
) -> dict:
    """Search the library of downloaded media, most recently added first."""
    body = {
        "sort": {"by": "registered", "order": -1},
        "range": [0, limit],
        "file_type_filter": {"any": "both", "audio": "audio_only", "video": "video_only"}[media_type],
        "favorite_filter": favorites_only,
    }
    if query.strip():
        body["text_search"] = query.strip()

    result = await call("getAllFiles", body)
    files = [present_file(item) for item in (result.get("files") or [])[:limit] if isinstance(item, dict)]
    return {"total": result.get("file_count", len(files)), "results": files}


@mcp.tool(annotations=READ_ONLY)
async def list_downloads(
    unfinished_only: Annotated[bool, Field(description="Only downloads that are queued, running or paused.")] = False,
    page: Annotated[int, Field(ge=0, description="Zero-based page of history. Ignored with unfinished_only.")] = 0,
    page_size: Annotated[int, Field(ge=1, le=25)] = 10,
) -> dict:
    """List this account's downloads, newest first, with their state and progress."""
    result = await call("downloads", {"only_unfinished": unfinished_only, "page": page, "page_size": page_size})
    # Unfinished downloads come back all at once, up to a hundred of them.
    downloads = [present_download(item) for item in (result.get("downloads") or [])[:page_size] if isinstance(item, dict)]
    return {
        "total": result.get("total_count", len(downloads)),
        "page": 0 if unfinished_only else result.get("page", page),
        "downloads": downloads,
    }


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True))
async def start_download(
    url: Annotated[str, Field(description="The http(s) address of the page to download from.")],
    media_type: Literal["video", "audio"] = "video",
) -> dict:
    """Queue a download. It returns once queued, not once finished: follow it with list_downloads."""
    url = url.strip()
    if urlsplit(url).scheme not in ("http", "https"):
        raise ToolError("start_download needs an http or https URL.")

    result = await call("downloadFile", {"url": url, "type": media_type})
    queued = result.get("downloads") or [result.get("download")]
    return {"downloads": [present_download(item) for item in queued if isinstance(item, dict)]}


async def control(route, download_uid, verb):
    download_uid = download_uid.strip()
    result = await call(route, {"download_uid": download_uid})
    if not result.get("success"):
        raise ToolError(
            f"ytdl-material did not {verb} download {download_uid}. This account has no download "
            "with that uid, or its state does not allow it; check it with list_downloads."
        )
    return {"download_uid": download_uid, "success": True}


DownloadUid = Annotated[str, Field(min_length=1, description="A download_uid from list_downloads or start_download.")]


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def pause_download(download_uid: DownloadUid) -> dict:
    """Pause a queued or running download."""
    return await control("pauseDownload", download_uid, "pause")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def resume_download(download_uid: DownloadUid) -> dict:
    """Resume a paused download."""
    return await control("resumeDownload", download_uid, "resume")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False))
async def cancel_download(download_uid: DownloadUid) -> dict:
    """Cancel a download. It cannot be resumed afterwards."""
    return await control("cancelDownload", download_uid, "cancel")


if __name__ == "__main__":
    mcp.run()
