/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type GetAllDownloadsRequest = {
    /**
     * Filters downloads with the array
     */
    uids?: Array<string> | null;
    /**
     * Filters downloads to unfinished queue items
     */
    only_unfinished?: boolean;
};
