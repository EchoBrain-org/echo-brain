import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonContextLiveApplicationV1, OpenedPersonContextLiveRuntimeV1, PersonContextLiveRuntimeFactoryV1 } from './person-context-live-runtime-v1.js';

export type { PersonContextProjectAuthorizationV1 as PersonTicketProjectAuthorizationV1 } from './person-context-live-runtime-v1.js';
export type PersonTicketLiveApplicationV1 = PersonContextLiveApplicationV1<PersonTicketCitationV1>;
export type OpenedPersonTicketLiveRuntimeV1 = OpenedPersonContextLiveRuntimeV1<PersonTicketCitationV1>;
export type PersonTicketLiveRuntimeFactoryV1 = PersonContextLiveRuntimeFactoryV1<PersonTicketCitationV1>;
