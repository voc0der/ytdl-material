/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Subscription } from './Subscription';
import type { UserPermission } from './UserPermission';

export type User = {
    uid?: string;
    name?: string;
    passhash?: string;
    subscriptions?: Array<Subscription>;
    created?: number;
    role?: string;
    permissions?: Array<UserPermission>;
    permission_overrides?: Array<UserPermission>;
    /**
     * Whether every other account may browse this user's library, read only.
     */
    library_shared?: boolean;
};
