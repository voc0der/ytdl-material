/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Schedule = {
    type: Schedule.type;
    data: {
/**
 * Days of the week it runs on, 0 for Monday to 6 for Sunday.
 */
dayOfWeek?: Array<number>;
hour?: number;
minute?: number;
/**
 * Repeats the schedule this many hours apart, lined up with hour and minute. Every 6 hours from 13:30 runs at 01:30, 07:30, 13:30 and 19:30.
 */
everyHours?: number;
timestamp?: number;
tz?: string;
};
};

export namespace Schedule {

    export enum type {
        TIMESTAMP = 'timestamp',
        RECURRING = 'recurring',
    }


}
