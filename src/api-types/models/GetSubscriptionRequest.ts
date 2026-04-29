/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type GetSubscriptionRequest = {
    /**
     * Subscription ID
     */
    id: string;
    /**
     * Subscription name
     */
    name?: string;
    /**
     * Include completed subscription files in the response
     */
    include_videos?: boolean;
};
