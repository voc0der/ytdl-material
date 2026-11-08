/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ShadowAssignment } from './ShadowAssignment';
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
    shadow?: ShadowAssignment;
    readonly shadow_session?: {
        actor_uid: string;
        actor_name: string;
        access: User.access;
        unavailable: boolean;
    };
};
export namespace User {
    export enum access {
        READ_ONLY = 'read_only',
        FULL = 'full',
    }
}
