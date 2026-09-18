# Hardware acceleration

Hardware acceleration applies to ffmpeg video processing, such as cropping. It does not accelerate fetching bytes from a source or make unsupported browser codecs playable.

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

## Verify what runs

At startup the app checks hardware encoding, then decoding. If encoding fails, processing falls back to software. If only decoding fails, it can still encode on the GPU.

Runtime processing also falls back in stages: hardware decode and encode, software decode with hardware encode, then entirely software. Hardware encoding is used for video in H.264-compatible containers such as MP4, MKV, MOV, and TS; other formats keep software encoding.

Inspect **Settings → Downloader** for the check result, or filter the server log:

```bash
docker logs ytdl-material 2>&1 | grep -E 'flight test|Cropping|software encoding'
```

At debug log level, the resolved ffmpeg command shows the actual encoder and decoding options. A configured mode alone does not prove the GPU was usable.
