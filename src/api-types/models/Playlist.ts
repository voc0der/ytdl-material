/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Playlist = {
    name: string;
    uids: Array<string>;
    id: string;
    thumbnailURL: string;
    /**
     * Informational only, as on DatabaseFile.
     */
    thumbnailPath?: string;
    /**
     * A playlist has no thumbnail of its own -- an automatic one borrows the
     * thumbnail of a file it contains. This is the uid of that file, and it is what
     * the thumbnail endpoint expects.
     */
    thumbnailFileUid?: string;
    registered: number;
    duration: number;
    /**
     * How many files the playlist holds. Only automatic playlists carry it, as they
     * have no uids array to count; for a normal playlist, count uids.
     */
    file_count?: number;
    user_uid?: string;
    auto?: boolean;
    sharingEnabled?: boolean;
    /**
     * Subscription whose downloads are automatically appended to this playlist
     */
    source_sub_id?: string;
    /**
     * For a playlist copied from a subscribed channel, the id of the channel's playlist
     */
    source_playlist_id?: string;
};
