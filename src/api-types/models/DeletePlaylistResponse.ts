/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { SuccessObject } from './SuccessObject';

export type DeletePlaylistResponse = (SuccessObject & {
    playlist_removed?: boolean;
    deleted_file_count?: number;
    failed_file_count?: number;
});
