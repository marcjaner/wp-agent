import type { Adapter } from './registry.js';
import { blockSpan, blockTree, updateBlockCommentAttributes } from '../blocks.js';

export type RenderedClassHint = (block: { name: string; attributes: Record<string, unknown> }) => string[];

export const generateBlocksClassNames: RenderedClassHint = block => {
  if (!block.name.startsWith('generateblocks/')) return [];
  const id = block.attributes.uniqueId;
  if (typeof id !== 'string' || !id) return [];
  const kind = block.name.slice('generateblocks/'.length);
  return [`gb-${kind}-${id}`];
};

export function generateBlocksStyleSummary(content: string, path: string) {
  const block = blockTree(content).find(item => item.path === path);
  if (!block || !/^generateblocks(?:-pro)?\//.test(block.name)) throw new Error(`GenerateBlocks block ${path} not found.`);
  const styles = block.attributes.styles && typeof block.attributes.styles === 'object' && !Array.isArray(block.attributes.styles)
    ? block.attributes.styles as Record<string, unknown> : {};
  return {
    path, name: block.name,
    uniqueId: typeof block.attributes.uniqueId === 'string' ? block.attributes.uniqueId : null,
    baseStyles: Object.fromEntries(Object.entries(styles).filter(([key]) => !key.startsWith('@'))),
    responsiveStyles: Object.fromEntries(Object.entries(styles).filter(([key]) => key.startsWith('@'))),
    globalClasses: Array.isArray(block.attributes.globalClasses) ? block.attributes.globalClasses : [],
    css: typeof block.attributes.css === 'string' ? block.attributes.css : '',
  };
}

export type GenerateBlocksStylePatch = {
  base?: Record<string, string | number>;
  responsive?: Record<string, Record<string, string | number>>;
};

function cssForStyles(uniqueId: string, styles: Record<string, unknown>): string {
  const selector = `.gb-element-${uniqueId}`;
  const declarations = (values: Record<string, unknown>) => Object.entries(values).map(([property, value]) => {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(property) || !['string', 'number'].includes(typeof value) || /[;{}]/.test(String(value))) throw new Error(`Unsupported GenerateBlocks style: ${property}`);
    return `${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${value}`;
  }).join(';');
  const base = Object.fromEntries(Object.entries(styles).filter(([key]) => !key.startsWith('@')));
  const output = Object.keys(base).length ? `${selector}{${declarations(base)}}` : '';
  return output + Object.entries(styles).filter(([key]) => key.startsWith('@')).map(([query, values]) => {
    if (!/^@media \(max-width: \d{2,4}px\)$/.test(query) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Unsupported GenerateBlocks media query: ${query}`);
    return `${query}{${selector}{${declarations(values as Record<string, unknown>)}}}`;
  }).join('');
}

export function setGenerateBlocksStyles(content: string, path: string, patch: GenerateBlocksStylePatch): string {
  const block = blockTree(content).find(item => item.path === path);
  if (block?.name !== 'generateblocks/element') throw new Error(`Block ${path} is not a GenerateBlocks Element.`);
  const uniqueId = block.attributes.uniqueId;
  if (typeof uniqueId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(uniqueId)) throw new Error(`Block ${path} has no usable uniqueId.`);
  if (!patch.base && !patch.responsive) throw new Error('Provide base or responsive styles.');
  if (patch.base && (typeof patch.base !== 'object' || Array.isArray(patch.base))) throw new Error('Base styles must be an object.');
  if (patch.responsive && (typeof patch.responsive !== 'object' || Array.isArray(patch.responsive))) throw new Error('Responsive styles must be an object.');
  const before = block.attributes.styles && typeof block.attributes.styles === 'object' && !Array.isArray(block.attributes.styles) ? block.attributes.styles as Record<string, unknown> : {};
  const existingCss = block.attributes.css;
  if (typeof existingCss === 'string' && existingCss && existingCss !== cssForStyles(uniqueId, before)) throw new Error(`Block ${path} has CSS that cannot be safely regenerated.`);
  const styles = { ...before, ...patch.base };
  for (const [query, values] of Object.entries(patch.responsive || {})) {
    const previous = styles[query];
    styles[query] = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), ...values };
  }
  const css = cssForStyles(uniqueId, styles);
  return updateBlockCommentAttributes(content, path, { styles, css });
}

export function setAccordionDefaultOpen(content: string, path: string, open: boolean): string {
  if (typeof open !== 'boolean') throw new Error('Accordion default state must be a boolean.');
  const block = blockTree(content).find(item => item.path === path);
  if (block?.name !== 'generateblocks-pro/accordion-item') throw new Error(`Block ${path} is not a GenerateBlocks Pro accordion item.`);
  const updated = updateBlockCommentAttributes(content, path, { openByDefault: open });
  const span = blockSpan(updated, path);
  const fragment = updated.slice(span.start, span.end);
  const commentEnd = fragment.indexOf('-->') + 3;
  const tag = fragment.slice(commentEnd).match(/<[^>]+>/)?.[0];
  const classAttribute = tag?.match(/\bclass="([^"]*)"/);
  if (!tag || !classAttribute) throw new Error(`Accordion item ${path} has unsupported saved markup.`);
  const classes = classAttribute[1].split(/\s+/).filter(Boolean);
  if (!classes.includes('gb-accordion__item')) throw new Error(`Accordion item ${path} has unsupported saved markup.`);
  const nextClasses = classes.filter(name => name !== 'gb-accordion__item-open');
  if (open) nextClasses.push('gb-accordion__item-open');
  const nextTag = tag.replace(classAttribute[0], `class="${nextClasses.join(' ')}"`);
  const tagStart = span.start + commentEnd + fragment.slice(commentEnd).indexOf(tag);
  return updated.slice(0, tagStart) + nextTag + updated.slice(tagStart + tag.length);
}

export const generateBlocksAdapter: Adapter = {
  id: 'generateblocks',
  detect: installation => installation.activePlugins.some(plugin => plugin.status === 'active' && (plugin.plugin?.split('/')[0] === 'generateblocks' || plugin.slug === 'generateblocks'))
    || installation.registeredBlocks.some(name => name.startsWith('generateblocks/')),
  capabilities: [
    { id: 'block.renderedClassHint', implementation: generateBlocksClassNames },
    { id: 'block.styleSummary', implementation: generateBlocksStyleSummary },
    { id: 'block.styleSet', implementation: setGenerateBlocksStyles },
    { id: 'accordion.defaultOpen', implementation: setAccordionDefaultOpen, available: installation =>
      installation.activePlugins.some(plugin => plugin.status === 'active' && (plugin.plugin?.split('/')[0] === 'generateblocks-pro' || plugin.slug === 'generateblocks-pro'))
      || installation.registeredBlocks.some(name => name.startsWith('generateblocks-pro/')) },
  ],
};
