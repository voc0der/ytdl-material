/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ShadowAssignment } from './ShadowAssignment';
export type UpdateUserRequest = {
    change_object: {
        uid: string;
        name?: string;
        role?: string;
        shadow?: ShadowAssignment;
    };
};
