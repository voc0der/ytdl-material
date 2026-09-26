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
    /**
     * For a channel, also download the videos in its playlists and keep each one as a playlist
     */
    retrieve_channel_playlists?: boolean;
    downloading?: boolean;
    paused?: boolean;
    refresh_status?: SubscriptionRefreshStatus;
    file_count?: number;
    /**
     * The newest downloaded file with a thumbnail, whose thumbnail the subscription is shown with.
     */
    thumbnail_file_uid?: string | null;
    /**
     * The source's id for the channel, or for a playlist the channel that owns it.
     */
    channel_id?: string | null;
    /**
     * When the artwork served by /api/subscriptionArtwork was last replaced, in epoch ms. Absent until there is artwork.
     */
    artwork_updated_at?: number | null;
    videos?: Array<any>;
};
