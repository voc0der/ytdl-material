#!/bin/sh
set -eu

# THANK YOU TALULAH (https://github.com/nottalulah) for your help in figuring this out
# and also optimizing some code with this commit.
# xoxo :D

# amd64/arm64 use BtbN's GPL builds because they include the hardware encoders
# (h264_amf, h264_nvenc, h264_qsv, h264_vaapi) needed for the ytdl_transcoding setting.
# armhf/armel fall back to John van Sickle's static builds, which are software-only.
case $(uname -m) in
  x86_64)
    ARCH=amd64
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz";;
  aarch64)
    ARCH=arm64
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linuxarm64-gpl-7.1.tar.xz";;
  armhf)
    ARCH=armhf
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-5.1.1-${ARCH}-static.tar.xz";;
  armv7)
    ARCH=armel
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-5.1.1-${ARCH}-static.tar.xz";;
  armv7l)
    ARCH=armel
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-5.1.1-${ARCH}-static.tar.xz";;
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
echo "(4/5) PROVISION - Provide ffmpeg and ffprobe from ffmpeg obtain layer"
FFMPEG_SRC="$(find /tmp/ffmpeg -type f -name ffmpeg | head -n 1)"
FFPROBE_SRC="$(find /tmp/ffmpeg -type f -name ffprobe | head -n 1)"
if [ -z "$FFMPEG_SRC" ] || [ -z "$FFPROBE_SRC" ]; then
  echo "Could not locate ffmpeg/ffprobe in extracted archive."
  exit 1
fi
install -m 0755 "$FFMPEG_SRC" /usr/local/bin/ffmpeg
install -m 0755 "$FFPROBE_SRC" /usr/local/bin/ffprobe
test -x /usr/local/bin/ffmpeg
test -x /usr/local/bin/ffprobe
echo "(5/5) CLEANUP - Remove temporary downloads from ffmpeg obtain layer"
rm -rf /tmp/ffmpeg ffmpeg.txz
