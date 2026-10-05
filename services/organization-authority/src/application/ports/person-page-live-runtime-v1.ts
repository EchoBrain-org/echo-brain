import type { PersonPageCitationV1 } from '@echo-brain/organization-api';
import type { PersonContextLiveApplicationV1, OpenedPersonContextLiveRuntimeV1, PersonContextLiveRuntimeFactoryV1 } from './person-context-live-runtime-v1.js';

export type { PersonContextProjectAuthorizationV1 as PersonPageProjectAuthorizationV1 } from './person-context-live-runtime-v1.js';
export type PersonPageLiveApplicationV1 = PersonContextLiveApplicationV1<PersonPageCitationV1>;
export type OpenedPersonPageLiveRuntimeV1 = OpenedPersonContextLiveRuntimeV1<PersonPageCitationV1>;
export type PersonPageLiveRuntimeFactoryV1 = PersonContextLiveRuntimeFactoryV1<PersonPageCitationV1>;
