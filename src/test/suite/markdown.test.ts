/**
 * Unit tests for the webview's Markdown renderer (src/chat/webview/markdown.js).
 */

import * as assert from 'assert';
import * as path from 'path';

// Plain JS shipped to the webview; loaded from source (tests run from out/test/suite)
const md = require(path.join(__dirname, '..', '..', '..', 'src', 'chat', 'webview', 'markdown.js')) as {
    renderMarkdown(text: string): string;
    highlightCode(code: string, lang: string): string;
};

suite('Webview Markdown', () => {
    test('escapes HTML in text so replies cannot inject markup', () => {
        const html = md.renderMarkdown('Use Vec<String> and <img src=x onerror=alert(1)>');
        assert.ok(html.includes('Vec&lt;String&gt;'));
        assert.ok(!html.includes('<img'));
    });

    test('keeps snake_case identifiers intact', () => {
        const html = md.renderMarkdown('call my_var_name and get_user_id now');
        assert.ok(!html.includes('<em>'), html);
        assert.ok(html.includes('my_var_name'));
    });

    test('does not apply bold/italic inside inline code', () => {
        const html = md.renderMarkdown('define `__init__` and `*args*`');
        assert.ok(html.includes('<code>__init__</code>'), html);
        assert.ok(html.includes('<code>*args*</code>'), html);
    });

    test('still renders bold, italic and safe links', () => {
        const html = md.renderMarkdown('**bold** *it* _also_ [docs](https://kiro.dev)');
        assert.ok(html.includes('<strong>bold</strong>'));
        assert.ok(html.includes('<em>it</em>'));
        assert.ok(html.includes('<em>also</em>'));
        assert.ok(html.includes('<a href="https://kiro.dev"'));
    });

    test('does not make javascript: links clickable', () => {
        const html = md.renderMarkdown('[x](javascript:alert(1))');
        assert.ok(!html.includes('<a '), html);
    });

    test('renders tables (as kiro-cli sends them)', () => {
        const html = md.renderMarkdown(
            '| Function | Returns |\n|----------|---------|\n| `add` | `a + b` |\n| `a\\|b` | x |'
        );
        assert.ok(html.includes('<table>'));
        assert.ok(html.includes('<th>Function</th>'));
        assert.ok(html.includes('<td><code>add</code></td>'));
        assert.ok(html.includes('<td><code>a|b</code></td>'), html);
    });

    test('highlights code without leaking markup into it', () => {
        const html = md.highlightCode('def add(a, b):\n    """Return a + b."""\n    return a + b  # sum', 'python');
        assert.ok(!html.includes('class=&quot;'), html);
        assert.strictEqual((html.match(/class="token-string"/g) || []).length, 1, html);
        assert.ok(html.includes('<span class="token-comment"># sum</span>'));
        // The visible text is exactly the original code
        const text = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        assert.strictEqual(text, 'def add(a, b):\n    """Return a + b."""\n    return a + b  # sum');
    });

    test('escapes HTML inside code blocks', () => {
        const html = md.renderMarkdown('```html\n<script>alert(1)</script>\n```');
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('renders an unclosed code fence while the reply is still streaming', () => {
        const html = md.renderMarkdown('Here:\n```ts\nconst x = 1;');
        assert.ok(html.includes('<pre>'));
        assert.ok(html.includes('token-keyword'));
    });
});
