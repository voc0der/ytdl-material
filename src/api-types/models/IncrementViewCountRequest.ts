/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type IncrementViewCountRequest = {
    file_uid: string;
    sub_id?: string;
    /**
     * User UID
     */
    uuid?: string;
    /**
     * Playlist ID, when the file is being played through a shared playlist
     */
    playlist_id?: string;
};
