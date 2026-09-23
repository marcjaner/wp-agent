import { parse } from '@wordpress/block-serialization-default-parser';

export type Block = {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: Block[];
  innerHTML: string;
  innerContent: Array<string | null>;
};

export function parseBlocks(content: string): Block[] {
  return parse(content) as Block[];
}

export function blockTree(content: string): Array<{ path: string; name: string; attributes: Record<string, unknown>; text: string }> {
  const output: Array<{ path: string; name: string; attributes: Record<string, unknown>; text: string }> = [];
  function visit(blocks: Block[], parent = ''): void {
    blocks.filter(block => block.blockName).forEach((block, index) => {
      const path = parent ? `${parent}.${index}` : String(index);
      output.push({ path, name: block.blockName!, attributes: block.attrs, text: block.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
      visit(block.innerBlocks, path);
    });
  }
  visit(parseBlocks(content));
  return output;
}

export function replaceText(content: string, from: string, to: string): { content: string; count: number } {
  if (!from) throw new Error('--from cannot be empty');
  parseBlocks(content);
  let count = 0;
  const escapedTo = to.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const updated = content.split(/(<!--[^]*?-->|<[^>]+>)/g).map(part => {
    if (part.startsWith('<')) return part;
    const pieces = part.split(from);
    count += pieces.length - 1;
    return pieces.join(escapedTo);
  }).join('');
  if (!count) throw new Error(`Visible text not found: ${from}`);
  return { content: updated, count };
}

type Span = { start: number; end: number; path: string };

function blockSpans(content: string): Span[] {
  const spans: Span[] = [];
  const stack: Array<{ start: number; path: string; children: number; name: string }> = [];
  let roots = 0;
  for (const match of content.matchAll(/<!--[\s\S]*?-->/g)) {
    const token = match[0].slice(4, -3).trim();
    if (token.startsWith('wp:')) {
      const name = token.slice(3).split(/\s/, 1)[0].replace(/\/$/, '');
      const parent = stack.at(-1);
      const index = parent ? parent.children++ : roots++;
      const path = parent ? `${parent.path}.${index}` : String(index);
      if (token.endsWith('/')) spans.push({ start: match.index, end: match.index + match[0].length, path });
      else stack.push({ start: match.index, path, children: 0, name });
    } else if (token.startsWith('/wp:')) {
      const opened = stack.pop();
      if (!opened) throw new Error('Unexpected Gutenberg closing delimiter.');
      if (opened.name !== token.slice(4)) throw new Error(`Mismatched Gutenberg closing delimiter at block ${opened.path}.`);
      spans.push({ start: opened.start, end: match.index + match[0].length, path: opened.path });
    }
  }
  if (stack.length) throw new Error('Unclosed Gutenberg block delimiter.');
  const parsed = blockTree(content);
  if (parsed.length !== spans.length || parsed.some(block => !spans.some(span => span.path === block.path))) {
    throw new Error('Could not safely match Gutenberg block delimiters to parsed blocks.');
  }
  return spans;
}

export function blockSpan(content: string, blockPath: string): Span {
  const span = blockSpans(content).find(item => item.path === blockPath);
  if (!span) throw new Error(`Block ${blockPath} not found.`);
  return span;
}

export function updateBlockCommentAttributes(content: string, blockPath: string, changes: Record<string, unknown>): string {
  const block = blockTree(content).find(item => item.path === blockPath);
  const span = blockSpan(content, blockPath);
  if (!block) throw new Error(`Block ${blockPath} not found.`);
  const fragment = content.slice(span.start, span.end);
  const end = fragment.indexOf('-->');
  const opening = fragment.slice(0, end + 3);
  const match = opening.match(/^<!-- wp:([^\s]+)(?: \{[\s\S]*\})? (\/)?-->$/);
  if (!match) throw new Error(`Block ${blockPath} has an unsupported opening delimiter.`);
  const attributes = { ...block.attributes, ...changes };
  const updated = `<!-- wp:${match[1]} ${JSON.stringify(attributes)}${match[2] ? ' /-->' : ' -->'}`;
  const result = content.slice(0, span.start) + updated + content.slice(span.start + opening.length);
  const after = blockTree(result).find(item => item.path === blockPath);
  if (after?.name !== block.name) throw new Error(`Block ${blockPath} changed type during attribute update.`);
  return result;
}

export function copyBlock(source: string, sourcePath: string, target: string, afterPath?: string): string {
  const sourceSpan = blockSpans(source).find(span => span.path === sourcePath);
  if (!sourceSpan) throw new Error(`Source block ${sourcePath} not found.`);
  const targetSpans = blockSpans(target);
  const afterSpan = afterPath === undefined ? undefined : targetSpans.find(span => span.path === afterPath);
  if (afterPath !== undefined && !afterSpan) throw new Error(`Target block ${afterPath} not found.`);
  const sourceTree = blockTree(source).filter(block => block.path === sourcePath || block.path.startsWith(`${sourcePath}.`));
  const targetIds = new Set(blockTree(target).map(block => block.attributes.uniqueId).filter(id => typeof id === 'string'));
  const duplicate = sourceTree.map(block => block.attributes.uniqueId).find(id => typeof id === 'string' && targetIds.has(id));
  if (duplicate) throw new Error(`Block uniqueId already exists on target page: ${duplicate}`);
  const fragment = source.slice(sourceSpan.start, sourceSpan.end);
  const position = afterSpan?.end ?? target.length;
  const result = `${target.slice(0, position)}\n\n${fragment}${target.slice(position)}`;
  blockSpans(result);
  return result;
}

export function removeBlock(content: string, blockPath: string): string {
  const span = blockSpans(content).find(item => item.path === blockPath);
  if (!span) throw new Error(`Block ${blockPath} not found.`);
  return content.slice(0, span.start) + content.slice(span.end);
}

export type ImageMedia = { id: number; url: string; alt: string; sizes?: Record<string, string> };

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setImageAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  const attribute = ` ${name}="${htmlAttribute(value)}"`;
  return pattern.test(tag) ? tag.replace(pattern, attribute) : tag.replace(/\s*(\/?)>$/, `${attribute}$1>`);
}

export function replaceImageBlock(content: string, blockPath: string, media: ImageMedia): string {
  if (!Number.isSafeInteger(media.id) || media.id <= 0) throw new Error('Media ID must be a positive integer.');
  const url = new URL(media.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Image URL must be HTTP(S) without credentials.');
  const block = blockTree(content).find(item => item.path === blockPath);
  if (block?.name !== 'core/image') throw new Error(`Block ${blockPath} is not a core/image block.`);
  const span = blockSpans(content).find(item => item.path === blockPath)!;
  const fragment = content.slice(span.start, span.end);
  const opening = fragment.match(/^<!-- wp:image(?:\s+(\{[\s\S]*?\}))? -->/);
  if (!opening) throw new Error('Image block has an unsupported opening delimiter.');
  const attrs = opening[1] ? JSON.parse(opening[1]) as Record<string, unknown> : {};
  const currentSize = typeof attrs.sizeSlug === 'string' ? attrs.sizeSlug : 'full';
  const size = currentSize !== 'full' && media.sizes?.[currentSize] ? currentSize : 'full';
  const imageUrl = size === 'full' ? media.url : media.sizes![size];
  attrs.id = media.id;
  attrs.sizeSlug = size;
  const tags = [...fragment.matchAll(/<img\b[^>]*>/g)];
  if (tags.length !== 1) throw new Error('Image block must contain exactly one image element.');
  let tag = tags[0][0];
  tag = setImageAttribute(tag, 'src', imageUrl);
  tag = setImageAttribute(tag, 'alt', media.alt);
  const classMatch = tag.match(/\sclass="([^"]*)"/);
  const classes = classMatch ? classMatch[1].replace(/\bwp-image-\d+\b/g, '').trim() : '';
  tag = setImageAttribute(tag, 'class', `${classes ? `${classes} ` : ''}wp-image-${media.id}`);
  tag = tag.replace(/\s(?:srcset|sizes|width|height)="[^"]*"/g, '');
  let updated = fragment.replace(opening[0], `<!-- wp:image ${JSON.stringify(attrs)} -->`).replace(tags[0][0], tag);
  if (size !== currentSize) updated = updated.replace(/\bsize-[a-z0-9_-]+\b/, `size-${size}`);
  return content.slice(0, span.start) + updated + content.slice(span.end);
}
