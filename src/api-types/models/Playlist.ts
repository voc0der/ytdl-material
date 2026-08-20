/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { FileType } from './FileType';

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
    type: FileType;
    registered: number;
    duration: number;
    user_uid?: string;
    auto?: boolean;
    sharingEnabled?: boolean;
};
