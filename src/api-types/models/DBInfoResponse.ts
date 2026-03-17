/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { TableInfo } from './TableInfo';

export type DBInfoResponse = {
    using_local_db?: boolean;
    current_db_type?: string;
    current_db_label?: string;
    configured_remote_db_type?: string;
    configured_remote_db_label?: string;
    stats_by_table?: {
files?: TableInfo;
playlists?: TableInfo;
categories?: TableInfo;
subscriptions?: TableInfo;
users?: TableInfo;
roles?: TableInfo;
download_queue?: TableInfo;
archives?: TableInfo;
};
};
