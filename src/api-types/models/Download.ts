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
     * Bounded error summary, set if the download fails. Legacy entries may return a generic placeholder.
     */
    error?: string | null;
    /**
     * Bounded persisted diagnostic for newly recorded failures.
     */
    error_summary?: string | null;
    /**
     * Whether heavyweight legacy error output was omitted from the response.
     */
    error_details_omitted?: boolean;
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
