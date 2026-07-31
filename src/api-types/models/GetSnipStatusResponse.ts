/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { DatabaseFile } from './DatabaseFile';

export type GetSnipStatusResponse = {
    success: boolean;
    status?: 'snipping' | 'complete' | 'failed';
    /**
     * Progress of the snip, 0-100
     */
    percent?: number;
    error?: string;
    file?: DatabaseFile;
};
