/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type SubscriptionRefreshStatus = {
    active?: boolean;
    phase?: 'idle' | 'collecting' | 'queueing' | 'queued' | 'complete' | 'cancelled' | 'error';
    discovered_count?: number;
    total_count?: number | null;
    new_items_count?: number | null;
    queued_count?: number;
    latest_item_title?: string | null;
    started_at?: number | null;
    updated_at?: number | null;
    completed_at?: number | null;
    error?: string | null;
    pending_download_count?: number;
    running_download_count?: number;
};
