/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Category } from './Category';
import type { SuccessObject } from './SuccessObject';

export type CreateDefaultCategoriesResponse = (SuccessObject & {
    categories?: Array<Category>;
});
