# Hardware acceleration

Hardware acceleration applies to ffmpeg video processing, such as cropping, [playback copies](#playback-copies) and [codec conversions](#codec-conversions). It does not accelerate fetching bytes from a source or make unsupported browser codecs playable.

Choose a mode in **Settings → Downloader** or set `ytdl_transcoding` to `vaapi`, `qsv`, `nvenc`, or `amf`. The default `false` uses software processing.

## VAAPI and QSV

Pass your host's GPU devices into the app container. Add the host's actual render/video group IDs; `44` and `106` below are examples, not portable defaults.

```yaml
environment:
  ytdl_transcoding: 'vaapi' # Use qsv for Intel Quick Sync.
group_add:
  - '44'
  - '106'
devices:
  - /dev/dri/renderD128:/dev/dri/renderD128
  - /dev/dri/card0:/dev/dri/card0
```

Find the relevant IDs on the host with `getent group render video`. Use devices that exist on your host.

For VAAPI/QSV, the root entrypoint installs the required userspace packages at startup. It needs network access and startup privileges. If you first enable the option in the UI, restart the container so those packages can be installed before the next hardware check.

## NVIDIA NVENC

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host and make the GPU available to the container. A Compose deployment can [reserve a GPU](https://docs.docker.com/compose/how-tos/gpu-support/) with:

```yaml
environment:
  ytdl_transcoding: 'nvenc'
  NVIDIA_VISIBLE_DEVICES: 'all'
  NVIDIA_DRIVER_CAPABILITIES: 'compute,video,utility'
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

For AMD AMF, set `amf` and provide a compatible host runtime. AMF is encode-only in this implementation; it does not attempt hardware decoding.

## Playback copies

External players that cannot decode AV1 can ask `POST /api/createPlaybackLink` for `"transcode": true`. The link then streams an H.264/AAC MP4 copy, made once through the same GPU-then-CPU fallback as cropping and stored in `appdata/transcodes`. The copy is always MP4, so it can use the GPU whatever the source container. Copies are made one at a time. Until a copy is ready, its stream answers `503` with `Retry-After`. Later links for the same file reuse the copy unless the file has changed since.

The **Delete old playback transcodes** task runs daily by default. It deletes copies that are over six hours old and not used by an unexpired link, queued or in progress. Lite server backups skip `appdata/transcodes`.

## Codec conversions

The [Codec discovery](../usage/tasks.md#codec-discovery) task converts the library to `ytdl_preferred_codec`. It uses the GPU's own encoder for that codec: `hevc_nvenc`, `av1_qsv`, `vp9_vaapi` and so on. The startup check only proves the H.264 encoder, and a GPU that encodes H.264 may have no HEVC or AV1 encoder, so each codec's encoder gets its own check the first time a conversion needs it. If that fails, conversions to that codec use the CPU (libx265, SVT-AV1, libvpx-vp9 or libx264), which is much slower. NVENC and AMF have no VP9 encoder.

## Verify what runs

At startup the app checks hardware encoding, then decoding. If encoding fails, processing falls back to software. If only decoding fails, it can still encode on the GPU.

Runtime processing also falls back in stages: hardware decode and encode, software decode with hardware encode, then entirely software. Hardware encoding is used for video in H.264-compatible containers such as MP4, MKV, MOV, and TS; other formats keep software encoding.

Inspect **Settings → Downloader** for the check result, or filter the server log:

```bash
docker logs ytdl-material 2>&1 | grep -E 'flight test|Cropping|Transcod|software encoding'
```

At debug log level, the resolved ffmpeg command shows the actual encoder and decoding options. A configured mode alone does not prove the GPU was usable.
