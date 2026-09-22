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

export function copyBlock(source: string, sourcePath: string, target: string, afterPath?: string): string {
  const sourceSpan = blockSpans(source).find(span => span.path === sourcePath);
  if (!sourceSpan) throw new Error(`Source block ${sourcePath} not found.`);
  const targetSpans = blockSpans(target);
  const afterSpan = afterPath === undefined ? undefined : targetSpans.find(span => span.path === afterPath);
  if (afterPath !== undefined && !afterSpan) throw new Error(`Target block ${afterPath} not found.`);
  if (afterPath?.includes('.')) throw new Error('Insertion after nested blocks is not supported.');
  const sourceTree = blockTree(source).filter(block => block.path === sourcePath || block.path.startsWith(`${sourcePath}.`));
  const targetIds = new Set(blockTree(target).map(block => block.attributes.uniqueId).filter(id => typeof id === 'string'));
  const duplicate = sourceTree.map(block => block.attributes.uniqueId).find(id => typeof id === 'string' && targetIds.has(id));
  if (duplicate) throw new Error(`Block uniqueId already exists on target page: ${duplicate}`);
  const fragment = source.slice(sourceSpan.start, sourceSpan.end);
  const position = afterSpan?.end ?? target.length;
  return `${target.slice(0, position)}\n\n${fragment}${target.slice(position)}`;
}
