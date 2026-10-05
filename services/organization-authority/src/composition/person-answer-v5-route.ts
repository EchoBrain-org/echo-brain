import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from './person-live-answer-route-v1.js';

export type CreatePersonAnswerV5RouteOptions = CreatePersonLiveAnswerRouteOptionsV1;
/** Compatible response adapter over the shared live-context Ask pipeline. */
export function createPersonAnswerV5Route(options: CreatePersonAnswerV5RouteOptions) {
  return createPersonLiveAnswerRouteV1(options, 6);
}
