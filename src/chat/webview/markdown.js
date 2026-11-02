/**
 * Kiro Chat Panel — small Markdown renderer for assistant replies.
 *
 * Loaded by the webview before main.js (exposes `window.KiroMarkdown`) and by
 * the unit tests through `require` (CommonJS export).
 *
 * All text is HTML-escaped before any markup is added, so replies can't inject
 * HTML, and every highlighter/inline pass works on raw text — never on HTML a
 * previous pass produced.
 */

(function (root) {
    'use strict';

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    // ---- Inline ----

    /** Only these link targets become clickable. */
    function safeUrl(url) {
        return /^(https?:|mailto:)/i.test(url) ? url : null;
    }

    /** Bold, italic and links on text that has no code spans. */
    function renderPlainInline(text) {
        var out = escapeHtml(text);
        // Links: [label](url) — escaping doesn't touch [ ] ( )
        out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
            // Undo the escaping of & so the check sees the real URL; the
            // escaped form is what goes into the attribute.
            var real = url.replace(/&amp;/g, '&');
            return safeUrl(real) ? '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>' : m;
        });
        // Bold: **x**, and __x__ only as a whole word
        out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
        // Italic: *x*, and _x_ only at word boundaries so snake_case_names survive
        out = out.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
        out = out.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
        return out;
    }

    /** Inline markdown: `code`, bold, italic, links, line breaks. */
    function renderInline(text) {
        var html = '';
        var re = /`([^`\n]+)`/g;
        var last = 0;
        var m;
        while ((m = re.exec(text)) !== null) {
            html += renderPlainInline(text.slice(last, m.index));
            html += '<code>' + escapeHtml(m[1]) + '</code>';
            last = re.lastIndex;
        }
        html += renderPlainInline(text.slice(last));
        return html.replace(/\n/g, '<br>');
    }

    // ---- Code highlighting ----

    var KEYWORDS = new Set((
        'const let var function return if else for while do switch case break continue ' +
        'class extends implements interface type enum import export from default new this ' +
        'try catch finally throw async await yield of in typeof instanceof void null undefined ' +
        'true false def self elif except raise with as pass lambda None True False and or not is ' +
        'public private protected static final abstract override readonly declare fn impl struct ' +
        'pub use mod match mut func package go defer select range then fi done esac echo'
    ).split(' '));
    var HASH_COMMENT_LANGS = new Set([
        'python', 'py', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'ruby', 'rb', 'toml',
        'ps1', 'powershell', 'pwsh', 'r', 'dockerfile', 'makefile', 'perl', 'conf', 'ini',
    ]);
    var PLAIN_LANGS = new Set(['', 'text', 'txt', 'plaintext', 'md', 'markdown', 'output', 'console']);

    /**
     * One pass over the raw code: each token is escaped and wrapped once.
     * @param {string} code Raw (unescaped) code
     * @param {string} lang
     */
    function highlightCode(code, lang) {
        lang = (lang || '').toLowerCase();
        if (PLAIN_LANGS.has(lang)) {
            return escapeHtml(code);
        }
        var hash = HASH_COMMENT_LANGS.has(lang);
        var re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
        var html = '';
        var last = 0;
        var m;
        while ((m = re.exec(code)) !== null) {
            html += escapeHtml(code.slice(last, m.index));
            last = re.lastIndex;
            var tok = escapeHtml(m[0]);
            if (m[1] !== undefined && !hash) {
                html += '<span class="token-comment">' + tok + '</span>';
            } else if (m[2] !== undefined && hash) {
                html += '<span class="token-comment">' + tok + '</span>';
            } else if (m[3] !== undefined) {
                html += '<span class="token-string">' + tok + '</span>';
            } else if (m[4] !== undefined) {
                html += '<span class="token-number">' + tok + '</span>';
            } else if (m[5] !== undefined && KEYWORDS.has(m[5])) {
                html += '<span class="token-keyword">' + tok + '</span>';
            } else if (m[1] !== undefined || m[2] !== undefined) {
                // Comment syntax of another language (e.g. # in JS): emit one
                // character and keep scanning so the rest still highlights
                html += escapeHtml(m[0].charAt(0));
                re.lastIndex = m.index + 1;
                last = re.lastIndex;
            } else {
                html += tok;
            }
        }
        return html + escapeHtml(code.slice(last));
    }

    // ---- Blocks ----

    var FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
    var UL = /^\s*[-*+]\s+/;
    var OL = /^\s*\d+[.)]\s+/;
    var HEADING = /^(#{1,6})\s+(.*)/;
    var HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
    var QUOTE = /^\s*>\s?/;
    var TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

    function splitRow(line) {
        var s = line.trim();
        if (s.charAt(0) === '|') { s = s.slice(1); }
        if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') { s = s.slice(0, -1); }
        // Split on | that isn't escaped and isn't inside `code`
        var cells = [];
        var cur = '';
        var inCode = false;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '`') { inCode = !inCode; }
            if (c === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
            if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
            cur += c;
        }
        cells.push(cur.trim());
        return cells;
    }

    function isTableStart(lines, i) {
        return lines[i].indexOf('|') !== -1 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1;
    }

    function startsBlock(lines, i) {
        var l = lines[i];
        return l.trim() === '' || FENCE.test(l) || UL.test(l) || OL.test(l) || HEADING.test(l) ||
            HR.test(l) || QUOTE.test(l) || isTableStart(lines, i);
    }

    /**
     * @param {string} text Markdown (may be a partial, still-streaming reply)
     * @returns {string} HTML
     */
    function renderMarkdown(text) {
        var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        var html = '';
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            var fence = line.match(FENCE);
            if (fence) {
                var lang = fence[2] || '';
                var closer = new RegExp('^\\s*' + fence[1] + '\\s*$');
                var code = [];
                i++;
                while (i < lines.length && !closer.test(lines[i])) {
                    code.push(lines[i]);
                    i++;
                }
                i++; // closing fence (absent while streaming)
                var header = '<div class="code-block-header">' +
                    (lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '') + '</div>';
                html += '<pre>' + header + '<code>' + highlightCode(code.join('\n'), lang) + '</code></pre>';
                continue;
            }

            if (line.trim() === '') { i++; continue; }

            var heading = line.match(HEADING);
            if (heading) {
                var level = heading[1].length;
                html += '<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>';
                i++;
                continue;
            }

            if (HR.test(line)) { html += '<hr>'; i++; continue; }

            if (isTableStart(lines, i)) {
                var head = splitRow(line);
                i += 2;
                html += '<table><thead><tr>' + head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
                while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
                    var cells = splitRow(lines[i]);
                    html += '<tr>';
                    for (var c = 0; c < head.length; c++) {
                        html += '<td>' + renderInline(cells[c] || '') + '</td>';
                    }
                    html += '</tr>';
                    i++;
                }
                html += '</tbody></table>';
                continue;
            }

            if (QUOTE.test(line)) {
                var quoted = [];
                while (i < lines.length && QUOTE.test(lines[i])) {
                    quoted.push(lines[i].replace(QUOTE, ''));
                    i++;
                }
                html += '<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>';
                continue;
            }

            if (UL.test(line) || OL.test(line)) {
                var ordered = OL.test(line);
                var itemRe = ordered ? OL : UL;
                html += ordered ? '<ol>' : '<ul>';
                while (i < lines.length && itemRe.test(lines[i])) {
                    html += '<li>' + renderInline(lines[i].replace(itemRe, '')) + '</li>';
                    i++;
                }
                html += ordered ? '</ol>' : '</ul>';
                continue;
            }

            var para = [];
            while (i < lines.length && (para.length === 0 || !startsBlock(lines, i))) {
                para.push(lines[i]);
                i++;
            }
            html += '<p>' + renderInline(para.join('\n')) + '</p>';
        }
        return html;
    }

    var api = { renderMarkdown: renderMarkdown, renderInline: renderInline, highlightCode: highlightCode, escapeHtml: escapeHtml };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.KiroMarkdown = api;
    }
})(typeof window !== 'undefined' ? window : this);
