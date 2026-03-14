/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Download = {
    uid: string;
    ui_uid?: string;
    running: boolean;
    finished: boolean;
    paused: boolean;
    cancelled?: boolean;
    finished_step: boolean;
    url: string;
    type: string;
    title: string;
    step_index: number;
    percent_complete: number;
    timestamp_start: number;
    /**
     * Error text, set if download fails.
     */
    error?: string | null;
    /**
     * Error type, may or may not be set in case of an error
     */
    error_type?: string | null;
    user_uid?: string;
    sub_id?: string;
    sub_name?: string;
    prefetched_info?: any;
    playlist_item_progress?: Array<any> | null;
    file_uids?: Array<string>;
    container?: any;
    duplicate_skip_only?: boolean;
    duplicate_skip_count?: number;
};
