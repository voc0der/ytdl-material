/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Library delegation, independent of the account's normal role. Null restores the account's own library.
 */
export type ShadowAssignment = {
    target_uid: string;
    access: ShadowAssignment.access;
};
export namespace ShadowAssignment {
    export enum access {
        READ_ONLY = 'read_only',
        FULL = 'full',
    }
}
