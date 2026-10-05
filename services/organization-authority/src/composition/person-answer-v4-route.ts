import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from './person-live-answer-route-v1.js';

export type CreatePersonAnswerV4RouteOptions = CreatePersonLiveAnswerRouteOptionsV1;
/** Compatible response adapter over the shared live-context Ask pipeline. */
export function createPersonAnswerV4Route(options: CreatePersonAnswerV4RouteOptions) {
  return createPersonLiveAnswerRouteV1(options, 5);
}
