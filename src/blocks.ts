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
