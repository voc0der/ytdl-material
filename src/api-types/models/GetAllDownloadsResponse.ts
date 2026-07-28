/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Download } from './Download';

export type GetAllDownloadsResponse = {
    downloads?: Array<Download>;
    /**
     * Total number of scoped downloads matching the request.
     */
    total_count?: number;
    /**
     * Zero-based page actually returned by the server.
     */
    page?: number;
    /**
     * Page size actually applied by the server.
     */
    page_size?: number;
};
