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
    /**
     * Zero-based history page. Ignored when filtering by UID or requesting only unfinished downloads.
     */
    page?: number;
    /**
     * Number of history items to return. The server clamps this value to its hard maximum.
     */
    page_size?: number;
};
