/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CropFileSettings } from './CropFileSettings';
import type { FileType } from './FileType';

export type DownloadRequest = {
    url: string;
    /**
     * Video format code. Overrides other quality options.
     */
    customQualityConfiguration?: string;
    /**
     * Custom command-line arguments for youtube-dl. Overrides all other options, except url.
     */
    customArgs?: string;
    /**
     * Additional command-line arguments for youtube-dl. Added to whatever args would normally be used.
     */
    additionalArgs?: string;
    /**
     * Custom output filename template.
     */
    customOutput?: string;
    /**
     * Login with this account ID
     */
    youtubeUsername?: string;
    /**
     * Account password
     */
    youtubePassword?: string;
    /**
     * Height of the video, if known
     */
    selectedHeight?: string;
    /**
     * Max height that should be used, useful for playlists. selectedHeight will override this.
     */
    maxHeight?: string;
    /**
     * Specify ffmpeg/avconv audio quality
     */
    maxBitrate?: string;
    /**
     * Preferred audio language code to use when alternate tracks are available.
     */
    selectedAudioLanguage?: string;
    type?: FileType;
    cropFileSettings?: CropFileSettings;
    /**
     * If using youtube-dl archive, download will ignore it
     */
    ignoreArchive?: boolean;
    /**
     * Ignore SponsorBlock removal for this download, even when the setting is enabled.
     */
    disableSponsorBlock?: boolean;
    /**
     * Treat a YouTube channel search URL as a playlist-style download.
     */
    channelSearchPlaylist?: boolean;
};
