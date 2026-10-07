/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { SuccessObject } from './SuccessObject';

export type BulkDownloadResponse = (SuccessObject & {
    /**
     * Links queued. A playlist counts once, however many batches it is split into.
     */
    queued_count: number;
    /**
     * Links left out as duplicates.
     */
    duplicate_count: number;
    /**
     * Entries left out for not being http or https links.
     */
    invalid_count: number;
});
