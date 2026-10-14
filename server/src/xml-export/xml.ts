//the whole xml side of the export: an element tree to a utf-8 document string. no library on purpose, the provisional
//document is a dozen flat elements and the escaping rules of xml 1.0 fit in one function. a text node and children never
//mix here, the builder has no use for mixed content

export type XmlNode = {
  name: string;
  attrs?: Record<string, string>;
  text?: string | null; //a leaf. null is the same as absent
  children?: (XmlNode | null)[]; //null entries are skipped: that is how an element whose value is null is omitted
};

//xml 1.0 forbids most control characters outright (not even escaped), and a lone surrogate has no utf-8 form at all.
//they are dropped: a database value with a stray \u0000 must not stop the export, and the sha256 is of what was sent
const FORBIDDEN = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

//what an element or attribute may be called. the builder names every element itself, this guards the day it builds one
//from data
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/*──────────────────────────────────────────────────────────────────────────*/

//text or attribute value: the five predefined entities, forbidden characters removed
export function escapeXml(value: string) {
  return String(value).replace(FORBIDDEN, '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/*──────────────────────────────────────────────────────────────────────────*/

//the declaration and the tree, one element per line, two spaces per level, a leaf on its own line (<Id>12</Id>).
//the layout is for the person who opens the file in the bucket; a consumer parses it and never sees the whitespace
export function serialize(root: XmlNode) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0)}\n`;
}

function render(node: XmlNode, depth: number): string {
  if (!NAME.test(node.name)) throw new Error(`invalid xml element name "${node.name}"`);
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => {
      if (!NAME.test(k)) throw new Error(`invalid xml attribute name "${k}"`);
      return ` ${k}="${escapeXml(v)}"`;
    })
    .join('');
  if (node.text != null) return `${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`;
  const children = (node.children || []).filter((c): c is XmlNode => c != null);
  if (!children.length) return `${pad}<${node.name}${attrs}/>`;
  return `${pad}<${node.name}${attrs}>\n${children.map((c) => render(c, depth + 1)).join('\n')}\n${pad}</${node.name}>`;
}
