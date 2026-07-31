/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type SnipFileResponse = {
    success: boolean;
    /**
     * Handle used to poll /api/getSnipStatus
     */
    job_uid?: string;
    error?: string;
};
