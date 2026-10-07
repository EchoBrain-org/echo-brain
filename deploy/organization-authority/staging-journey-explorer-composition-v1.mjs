import { createStagingJourneyExplorerModuleV1 } from './staging-journey-explorer-handler-v1.mjs';
import { legacyProviderTelemetryVocabulariesV1 } from './legacy-provider-telemetry-vocabulary-v1.mjs';
import openrouter from '@echo-brain/provider-openrouter/assets/telemetry-vocabulary.v1.json' with { type: 'json' };
import slack from '@echo-brain/provider-slack-server/assets/telemetry-vocabulary.v1.json' with { type: 'json' };

// The reader retains known historical labels across the fixed 14-day query window.
const selected = [...legacyProviderTelemetryVocabulariesV1, openrouter, slack];
const explorer = createStagingJourneyExplorerModuleV1({
  providers: selected.flatMap(value => value.providers),
  models: selected.flatMap(value => value.models),
  legacy_phases: selected.flatMap(value => value.legacy_phases),
});
export const { createStagingJourneyExplorerHandlerV1, parseRequestV1, summarizeJourneyEventsV1, timelineV1, handler } = explorer;
