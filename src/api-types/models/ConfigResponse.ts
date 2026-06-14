/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Config } from './Config';

export type ConfigResponse = {
    config_file: Config;
    ytdlp_impersonation_available?: boolean;
    success: boolean;
};
