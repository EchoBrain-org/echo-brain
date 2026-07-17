import {
  adapterInstanceKey,
  type AdapterConfig,
  type AdapterKind,
} from '../contracts/adapter.js';
import type {
  AnyAdapter,
  CommunicationChannelAdapter,
  DecisionProcessorAdapter,
  MeetingSourceAdapter,
} from '../ports/adapters.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, AnyAdapter>();

  register(adapter: AnyAdapter): void {
    const { kind, adapter_id: adapterId, instance_id: instanceId } = adapter.identity;
    const key = adapterInstanceKey(kind, adapterId, instanceId);
    if (this.adapters.has(key)) {
      throw new Error(`adapter already registered: ${key}`);
    }
    this.adapters.set(key, adapter);
  }

  get(kind: AdapterKind, adapterId: string, instanceId: string): AnyAdapter | undefined {
    return this.adapters.get(adapterInstanceKey(kind, adapterId, instanceId));
  }

  getMeetingSource(config: AdapterConfig): MeetingSourceAdapter | undefined {
    return this.get('meeting-source', config.adapter_id, config.instance_id) as
      | MeetingSourceAdapter
      | undefined;
  }

  getDecisionProcessor(config: AdapterConfig): DecisionProcessorAdapter | undefined {
    return this.get('decision-processor', config.adapter_id, config.instance_id) as
      | DecisionProcessorAdapter
      | undefined;
  }

  getCommunicationChannel(config: AdapterConfig): CommunicationChannelAdapter | undefined {
    return this.get('communication-channel', config.adapter_id, config.instance_id) as
      | CommunicationChannelAdapter
      | undefined;
  }

  list(kind?: AdapterKind): readonly AnyAdapter[] {
    const adapters = [...this.adapters.values()];
    return kind === undefined ? adapters : adapters.filter((adapter) => adapter.identity.kind === kind);
  }
}
