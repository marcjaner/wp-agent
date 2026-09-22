import type { Adapter } from './registry.js';

export type RenderedClassHint = (block: { name: string; attributes: Record<string, unknown> }) => string[];

export const generateBlocksClassNames: RenderedClassHint = block => {
  if (!block.name.startsWith('generateblocks/')) return [];
  const id = block.attributes.uniqueId;
  if (typeof id !== 'string' || !id) return [];
  const kind = block.name.slice('generateblocks/'.length);
  return [`gb-${kind}-${id}`];
};

export const generateBlocksAdapter: Adapter = {
  id: 'generateblocks',
  detect: installation => installation.activePlugins.some(plugin => plugin.status === 'active' && (plugin.plugin?.split('/')[0] === 'generateblocks' || plugin.slug === 'generateblocks'))
    || installation.registeredBlocks.some(name => name.startsWith('generateblocks/')),
  capabilities: [{ id: 'block.renderedClassHint', implementation: generateBlocksClassNames }],
};
