import { generatePressAdapter } from './generatepress.js';
import { generateBlocksAdapter } from './generateblocks.js';

export type Installation = {
  activeTheme?: { template?: string; stylesheet?: string };
  activePlugins: Array<{ plugin?: string; slug?: string; status: string }>;
  registeredBlocks: string[];
};

export type AdapterCapability = { id: string; implementation?: unknown };

export type Adapter = {
  id: string;
  detect(installation: Installation): boolean;
  capabilities: readonly AdapterCapability[];
};

export const builtInAdapters: readonly Adapter[] = [generatePressAdapter, generateBlocksAdapter];

export function detectAdapters(installation: Installation, adapters: readonly Adapter[] = builtInAdapters): Adapter[] {
  return adapters.filter(adapter => adapter.detect(installation));
}

export function capabilityImplementations<T>(adapters: readonly Adapter[], id: string): T[] {
  return adapters.flatMap(adapter => adapter.capabilities.filter(capability => capability.id === id && capability.implementation !== undefined).map(capability => capability.implementation as T));
}

export function describeAdapters(adapters: readonly Adapter[]): Array<{ id: string; capabilities: string[] }> {
  return adapters.map(adapter => ({ id: adapter.id, capabilities: adapter.capabilities.map(capability => capability.id) }));
}
