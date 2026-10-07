/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { FileType } from './FileType';

export type BulkDownloadRequest = {
    urls: Array<string>;
    type?: FileType;
};
