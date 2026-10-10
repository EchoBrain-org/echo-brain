import { APPROVAL_DECISION_RECORD_INPUT_CODEC_V1, createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1 } from '@echo-brain/organization-protocol';
import {
  createPersonPolicyFactProjectorV2, createRecordPolicyFactProjectorRegistryV1, type RecordApproverProjectorV1, type RecordPolicyFactProjectorRegistryV1,
} from '@echo-brain/organization-record/organization-record-api-v1';
import { createApprovalDecisionPolicyProjectorV1, projectApprovalDecisionApproverV1 } from './approval-decision-projection-v1.js';

/**
 * Every record protocol this Authority appends or reads. V14 resets the record log, so no historical protocol is retained.
 * The composition root, the test fixtures, the staging canary test and the eval harness all import this one list.
 */
export const AUTHORITY_RECORD_INPUT_CODECS_V1 = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, APPROVAL_DECISION_RECORD_INPUT_CODEC_V1]);
/** A fresh registry per caller (projector registries are cheap and stateless; one instance per runtime is shared by appender and reader). */
export function authorityRecordPolicyProjectorsV1(): RecordPolicyFactProjectorRegistryV1 {
  return createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2(), createApprovalDecisionPolicyProjectorV1()]);
}
export const AUTHORITY_RECORD_APPROVER_PROJECTORS_V1: readonly RecordApproverProjectorV1[] = Object.freeze([projectApprovalDecisionApproverV1]);
