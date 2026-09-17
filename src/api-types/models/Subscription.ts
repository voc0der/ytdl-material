/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { FileType } from './FileType';
import type { SubscriptionRefreshStatus } from './SubscriptionRefreshStatus';

export type Subscription = {
    name: string;
    url: string;
    id: string;
    type: FileType;
    user_uid: string | null;
    isPlaylist: boolean;
    child_process?: any;
    archive?: string;
    timerange?: string;
    maxQuality?: string;
    custom_args?: string;
    custom_output?: string;
    use_subfolder?: boolean;
    auto_create_playlist?: boolean;
    downloading?: boolean;
    paused?: boolean;
    refresh_status?: SubscriptionRefreshStatus;
    file_count?: number;
    /**
     * The newest downloaded file with a thumbnail, whose thumbnail the subscription is shown with.
     */
    thumbnail_file_uid?: string | null;
    videos?: Array<any>;
};
