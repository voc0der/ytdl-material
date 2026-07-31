/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type SnipFileRequest = {
    /**
     * UID of the file to snip
     */
    uid: string;
    /**
     * Start of the range to keep, in seconds
     */
    start: number;
    /**
     * End of the range to keep, in seconds
     */
    end: number;
};
