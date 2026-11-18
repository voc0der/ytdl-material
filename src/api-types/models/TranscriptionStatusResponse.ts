/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type TranscriptionStatusResponse = {
    success: boolean;
    /**
     * Null when the file is not being transcribed and was not transcribed on its own lately
     */
    status?: 'transcribing' | 'complete' | 'failed' | null;
    /**
     * How much of the file is done, 0-100
     */
    percent?: number | null;
    /**
     * Why it failed
     */
    error?: string | null;
};
