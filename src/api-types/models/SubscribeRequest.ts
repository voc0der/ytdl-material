/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type SubscribeRequest = {
    name: string;
    url: string;
    timerange?: string;
    audioOnly?: boolean;
    customArgs?: string;
    customFileOutput?: string;
    useSubfolder?: boolean;
    autoCreatePlaylist?: boolean;
    /**
     * For a channel, also download the videos in its playlists and keep each one as a playlist
     */
    retrieveChannelPlaylists?: boolean;
    maxQuality?: string;
};
