// ==UserScript==
// @name         Gizmo AI - Block Heart Loss
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Prevents heart loss on wrong answers by bypassing the hearts/lives system
// @match        https://app.gizmo.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__GIZMO_NO_HEART_LOSS__) return;
    window.__GIZMO_NO_HEART_LOSS__ = true;

    const LOG = '[Gizmo No Heart Loss]';
    const PATCHES_URL =
        'https://raw.githubusercontent.com/noigelecnal/gzmo/refs/heads/main/Gizmo.json'
    const ENTRY_RE = /\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js(?:\?|#|$)/i;

    const FALLBACK_RULES = [
        {
            id: 'is-subscribed',
            find: String.raw`\br\(_?d\[\d+\]\)\.isSubscribedStore\.get\(\)`,
            flags: 'g',
            replace: '(!0)',
            minMatches: 1,
        },
        {
            id: 'subscription-status',
            find: String.raw`'subscribed'===\(0,[\w$]+\.default\)\(this,[\w$]+\)\[[\w$]+\]\.state\.snapshot\?\.subscription\?\.status`,
            flags: 'g',
            replace: '(!0)',
            minMatches: 1,
        },
    ];

    const isEntryScriptSrc = (src) => src && ENTRY_RE.test(src);

    const applyPatchRules = (source, rules) => {
        let output = source;
        for (const rule of rules) {
            const re = new RegExp(rule.find, rule.flags);
            output = output.replace(re, rule.replace);
        }
        return output;
    };

    const fetchPatchRules = async () => {
        try {
            const res = await fetch(PATCHES_URL, { cache: 'default' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!Array.isArray(json.rules) || json.rules.length === 0) {
                throw new Error('No rules in patches.json');
            }
            console.log(`${LOG} loaded ${json.rules.length} patch rules (hash=${json.hash})`);
            return json.rules;
        } catch (err) {
            console.warn(`${LOG} using fallback patch rules:`, err);
            return FALLBACK_RULES;
        }
    };

    const fetchAndPatchBundle = async (originalUrl) => {
        const absoluteUrl = new URL(originalUrl, location.origin).href;
        const [rules, bundleRes] = await Promise.all([
            fetchPatchRules(),
            fetch(absoluteUrl, { cache: 'default' }),
        ]);

        if (!bundleRes.ok) {
            throw new Error(`Bundle fetch failed: HTTP ${bundleRes.status}`);
        }

        const original = await bundleRes.text();
        if (original.length < 1000) {
            throw new Error(`Bundle suspiciously small (${original.length} bytes)`);
        }

        const patched = applyPatchRules(original, rules);
        console.log(`${LOG} patched bundle (${original.length} -> ${patched.length} bytes)`);
        return patched;
    };

    // --- SRI bypass (Gizmo may attach integrity attributes) ---
    const origAppendChild = Node.prototype.appendChild;
    const origInsertBefore = Node.prototype.insertBefore;
    const origAppend = Element.prototype.append;
    const origRemoveAttribute = Element.prototype.removeAttribute;
    const origSetAttribute = Element.prototype.setAttribute;
    const origGetAttribute = Element.prototype.getAttribute;
    const origCreateElement = Document.prototype.createElement;

    const lockIntegrity = (el) => {
        Object.defineProperty(el, 'integrity', {
            set() {},
            get() {
                return '';
            },
            configurable: true,
        });
    };

    Document.prototype.createElement = function (tagName, options) {
        const el = origCreateElement.call(this, tagName, options);
        const tag = tagName.toLowerCase();
        if (tag === 'script' || tag === 'link') lockIntegrity(el);
        return el;
    };

    Element.prototype.setAttribute = function (name, value) {
        if (name === 'integrity') return;
        return origSetAttribute.call(this, name, value);
    };

    for (const Proto of [HTMLScriptElement.prototype, HTMLLinkElement.prototype]) {
        Object.defineProperty(Proto, 'integrity', {
            set() {},
            get() {
                return '';
            },
            configurable: true,
        });
    }

    const stripIntegrity = (node) => {
        if (node instanceof HTMLScriptElement || node instanceof HTMLLinkElement) {
            if (origGetAttribute.call(node, 'integrity')) {
                origRemoveAttribute.call(node, 'integrity');
            }
        }
    };

    // --- Entry script interception ---
    let patchHandled = false;

    const isInterceptableGameScript = (node) => {
        if (!(node instanceof HTMLScriptElement)) return false;
        if (origGetAttribute.call(node, 'data-gizmo-patched') === '1') return false;
        return isEntryScriptSrc(node.src || origGetAttribute.call(node, 'src') || '');
    };

    const captureSrc = (node) => node.src || origGetAttribute.call(node, 'src') || '';

    const createNopScript = () => {
        const nop = origCreateElement.call(document, 'script');
        lockIntegrity(nop);
        origSetAttribute.call(nop, 'data-gizmo-patched', '1');
        return nop;
    };

    const injectPatchedBundle = (originalUrl) => {
        if (patchHandled) return;
        patchHandled = true;

        console.log(`${LOG} intercepting entry bundle: ${originalUrl}`);
        fetchAndPatchBundle(originalUrl)
            .then((js) => {
                const payload = 'var URL=window.URL;\n' + js;
                document.documentElement.setAttribute('onreset', payload);
                document.documentElement.dispatchEvent(new CustomEvent('reset'));
                document.documentElement.removeAttribute('onreset');
                console.log(`${LOG} patched bundle injected — hearts will not be lost on wrong answers`);
            })
            .catch((err) => {
                patchHandled = false;
                console.error(`${LOG} failed to patch bundle:`, err);
            });
    };

    Node.prototype.appendChild = function (child) {
        if (isInterceptableGameScript(child)) {
            injectPatchedBundle(captureSrc(child));
            return origAppendChild.call(this, createNopScript());
        }
        stripIntegrity(child);
        return origAppendChild.call(this, child);
    };

    Node.prototype.insertBefore = function (newNode, refNode) {
        if (isInterceptableGameScript(newNode)) {
            injectPatchedBundle(captureSrc(newNode));
            return origInsertBefore.call(this, createNopScript(), refNode);
        }
        stripIntegrity(newNode);
        return origInsertBefore.call(this, newNode, refNode);
    };

    Element.prototype.append = function (...nodes) {
        const processed = nodes.map((node) => {
            if (node instanceof Node && isInterceptableGameScript(node)) {
                injectPatchedBundle(captureSrc(node));
                return createNopScript();
            }
            if (node instanceof Node) stripIntegrity(node);
            return node;
        });
        return origAppend.apply(this, processed);
    };

    const handleParserAddedEntryScript = (script) => {
        const originalUrl = captureSrc(script);
        origSetAttribute.call(script, 'data-gizmo-patched', '1');
        script.removeAttribute('src');
        script.textContent = '';
        injectPatchedBundle(originalUrl);
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLScriptElement) {
                    if (origGetAttribute.call(node, 'integrity')) {
                        origRemoveAttribute.call(node, 'integrity');
                    }
                    if (
                        origGetAttribute.call(node, 'data-gizmo-patched') !== '1' &&
                        isEntryScriptSrc(node.src || origGetAttribute.call(node, 'src') || '')
                    ) {
                        handleParserAddedEntryScript(node);
                    }
                } else if (node instanceof HTMLLinkElement) {
                    if (origGetAttribute.call(node, 'integrity')) {
                        origRemoveAttribute.call(node, 'integrity');
                    }
                    const href = node.href || '';
                    const rel = (node.rel || '').toLowerCase();
                    if (rel === 'preload' && isEntryScriptSrc(href)) {
                        node.remove();
                    }
                }
            }
        }
    });

    const scanExistingDom = () => {
        const existing = document.querySelector(
            'script[src*="/_expo/static/js/web/entry-"]:not([data-gizmo-patched])'
        );
        if (existing) handleParserAddedEntryScript(existing);

        document.querySelectorAll('link[rel="preload"]').forEach((link) => {
            if (isEntryScriptSrc(link.href)) link.remove();
        });

        document.querySelectorAll('script[integrity], link[integrity]').forEach((el) => {
            origRemoveAttribute.call(el, 'integrity');
        });
    };

    const root = document.documentElement || document;
    observer.observe(root, { childList: true, subtree: true });

    if (!document.documentElement) {
        const earlyObserver = new MutationObserver(() => {
            if (document.documentElement) {
                earlyObserver.disconnect();
                observer.observe(document.documentElement, { childList: true, subtree: true });
            }
        });
        earlyObserver.observe(document, { childList: true });
    }

    scanExistingDom();
    console.log(`${LOG} active on ${location.href}`);
})();
