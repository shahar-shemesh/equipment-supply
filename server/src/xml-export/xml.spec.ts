import { escapeXml, serialize } from './xml';

//the serializer behind every exported document: escaping, the characters xml 1.0 forbids, null children, the layout

describe('escapeXml', () => {
    it('escapes the five predefined entities and nothing else', () => {
        expect(escapeXml(`a & b < c > d "e" 'f'`)).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
        expect(escapeXml('ישראל ישראלי, הרצל 10')).toBe('ישראל ישראלי, הרצל 10');
    });

    it('drops the control characters xml 1.0 forbids and lone surrogates, keeps tab, newline and astral characters', () => {
        expect(escapeXml('a\u0000b\u0001c\u001fd￾e')).toBe('abcde');
        expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
        expect(escapeXml('x\ud800y')).toBe('xy');
        expect(escapeXml('\u{1F600}')).toBe('\u{1F600}');
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('serialize', () => {
    it('writes the declaration, attributes, one element per line and a leaf inline', () => {
        const xml = serialize({ name: 'Root', attrs: { xmlns: 'urn:x', v: '1 < 2' }, children: [{ name: 'A', text: 'one & two' }, { name: 'B', children: [{ name: 'C', text: '3' }] }] });
        expect(xml).toBe(['<?xml version="1.0" encoding="UTF-8"?>', '<Root xmlns="urn:x" v="1 &lt; 2">', '  <A>one &amp; two</A>', '  <B>', '    <C>3</C>', '  </B>', '</Root>', ''].join('\n'));
    });

    it('skips null children, so an element whose value is null is absent and not empty, and closes an element with nothing in it', () => {
        expect(serialize({ name: 'R', children: [null, { name: 'A', text: 'x' }, null] })).toContain('<R>\n  <A>x</A>\n</R>');
        expect(serialize({ name: 'R', children: [null] })).toContain('<R/>');
        expect(serialize({ name: 'R', children: [{ name: 'A', text: '' }] })).toContain('<A></A>');
    });

    it('refuses an element or attribute name it did not expect', () => {
        expect(() => serialize({ name: 'bad name' })).toThrow('invalid xml element name');
        expect(() => serialize({ name: '1st' })).toThrow('invalid xml element name');
        expect(() => serialize({ name: 'R', attrs: { 'a b': 'x' } })).toThrow('invalid xml attribute name');
    });
});
