# NAS and ARM hosts

Use the [Docker guide](docker.md) as the baseline. Host-specific setup mainly changes mount paths, account IDs, device access, and firewall rules.

## Synology

Create persistent folders for the five app mounts and the database, then use the NAS account's actual UID and GID. Make sure the app can write to those folders.

If containers are healthy but the UI cannot be reached from your LAN, review the active DSM firewall profile. Add an allow rule for the actual LAN subnet above broader deny rules and retest `http://<nas-ip>:17442`. Docker networking may also require a rule for its subnet. Do not use a broad example subnet without checking your own network.

A reverse proxy must be able to reach the app container or its published host port. If you configured `ytdl_reverse_proxy_whitelist`, verify the peer IP matches the allowlist.

## Unraid

Map all five app directories to persistent storage and configure the database as a separate service or external server. PostgreSQL is the default for new Compose installations; MongoDB remains supported for existing libraries.

Plan subscription storage around cache-pool capacity and mover behavior. A subscription can download a large backlog, and an exhausted cache can affect both media and database writes. Use a time range and conservative concurrency while establishing a new collection.

When configuring a container template, copy the current [environment variables](../reference/environment.md) and container paths rather than older wiki examples that require a nightly image or assume MongoDB is the only remote database.

## Raspberry Pi and other ARM systems

Official app images require a **64-bit arm64 OS** on ARM hosts. ARMv7 image builds have been retired. A 64-bit CPU running a 32-bit userspace does not satisfy that requirement.

Check the database image's CPU requirements separately from the app's architecture. A historical MongoDB 4 pin does not establish support for a current deployment. PostgreSQL or local JSON avoids depending on that old MongoDB workaround.

Use reliable persistent storage, and watch free space during playlist downloads and archive creation. Hardware acceleration depends on the actual host GPU, drivers, and supported ffmpeg mode; the presence of an ARM SoC alone does not imply VAAPI, QSV, NVENC, or AMF support.
