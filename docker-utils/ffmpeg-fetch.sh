#!/bin/sh
set -eu

# THANK YOU TALULAH (https://github.com/nottalulah) for your help in figuring this out
# and also optimizing some code with this commit.
# xoxo :D

# amd64/arm64 use BtbN's GPL builds because they include the hardware encoders
# (h264_amf, h264_nvenc, h264_qsv, h264_vaapi) needed for the ytdl_transcoding setting.
#
# These are the shared-library variants: same source, configuration and encoders as the
# static builds, but the codec libraries are stored once under lib/ instead of being linked
# into both ffmpeg and ffprobe. The binaries find them through an $ORIGIN/../lib rpath, so
# bin/ and lib/ have to be installed next to each other.
case $(uname -m) in
  x86_64)
    ARCH=amd64
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-shared-9.0.tar.xz";;
  aarch64)
    ARCH=arm64
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linuxarm64-gpl-shared-9.0.tar.xz";;
  *)
    echo "Unsupported architecture: $(uname -m)"
    exit 1
esac

echo "(INFO) Architecture detected: $ARCH"
echo "(1/5) READY - Acquire temp dependencies in ffmpeg obtain layer"
apt-get update && apt-get -y install --no-install-recommends ca-certificates curl xz-utils
echo "(2/5) DOWNLOAD - Acquire ffmpeg and ffprobe from ${FFMPEG_URL} in ffmpeg obtain layer"
curl -fL -o ffmpeg.txz \
    --connect-timeout 5 \
    --max-time 300 \
    --retry 5 \
    --retry-delay 0 \
    --retry-max-time 120 \
    --retry-all-errors \
    "$FFMPEG_URL"
mkdir /tmp/ffmpeg
tar xf ffmpeg.txz -C /tmp/ffmpeg
echo "(3/5) CLEANUP - Remove temp dependencies from ffmpeg obtain layer"
apt-get -y remove curl xz-utils
apt-get -y autoremove
echo "(4/5) PROVISION - Stage ffmpeg, ffprobe and their shared libraries in /ffmpeg"
FFMPEG_SRC="$(find /tmp/ffmpeg -type f -path '*/bin/ffmpeg' | head -n 1)"
if [ -z "$FFMPEG_SRC" ]; then
  echo "Could not locate ffmpeg in extracted archive."
  exit 1
fi
FFMPEG_ROOT="$(dirname "$(dirname "$FFMPEG_SRC")")"
if [ ! -f "$FFMPEG_ROOT/bin/ffprobe" ] || ! ls "$FFMPEG_ROOT"/lib/*.so.* >/dev/null 2>&1; then
  echo "Could not locate ffprobe and the shared libraries in extracted archive."
  exit 1
fi
install -d /ffmpeg/bin /ffmpeg/lib
install -m 0755 "$FFMPEG_ROOT/bin/ffmpeg" "$FFMPEG_ROOT/bin/ffprobe" /ffmpeg/bin/
# The versioned objects and their soname links are all the binaries load. The unversioned
# .so links, headers, pkg-config files, ffplay, docs and man pages are left behind.
cp -P "$FFMPEG_ROOT"/lib/*.so.* /ffmpeg/lib/
test -x /ffmpeg/bin/ffmpeg
test -x /ffmpeg/bin/ffprobe
echo "(5/5) CLEANUP - Remove temporary downloads from ffmpeg obtain layer"
rm -rf /tmp/ffmpeg ffmpeg.txz
