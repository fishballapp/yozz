// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMailFrame } from './html';

const blocked = (html: string) => buildMailFrame(html, { allowRemoteImages: false });

describe('buildMailFrame', () => {
  it('strips scripts, event handlers, SVG, MathML and templates', () => {
    const { srcdoc } = blocked(
      `<p onclick="steal()">hi</p><script>steal()</script><img src="x" onerror="steal()">
      <svg><a href="https://evil.example"><text>svg</text></a></svg>
      <math><mtext>math</mtext></math><template><img src="https://evil.example/t"></template>`,
    );
    expect(srcdoc).not.toContain('steal');
    expect(srcdoc).not.toContain('<svg');
    expect(srcdoc).not.toContain('<math');
    expect(srcdoc).not.toContain('<template');
    expect(srcdoc).not.toContain('evil.example');
  });

  it('blocks remote images until asked, reports them, and adds no-referrer', () => {
    const html =
      '<img src="https://tracker.example/pixel.gif"><img src="data:image/gif;base64,R0lGOD">';
    const denied = blocked(html);
    expect(denied.hasRemoteImages).toBe(true);
    expect(denied.srcdoc).not.toContain('tracker.example');
    expect(denied.srcdoc).toContain('data:image/gif');
    expect(denied.srcdoc).toContain('img-src data:;');

    const allowed = buildMailFrame(html, { allowRemoteImages: true });
    expect(allowed.srcdoc).toContain('https://tracker.example/pixel.gif');
    expect(allowed.srcdoc).toContain('referrerpolicy="no-referrer"');
    expect(allowed.srcdoc).toContain('img-src data: https://tracker.example');
  });

  it('marks a withheld image as a click target only while it is withheld', () => {
    const html = '<img src="https://cdn.example/hero.png" width="600" height="200">';
    const denied = blocked(html);
    expect(denied.srcdoc).toContain('<img src="data:image/gif;base64');
    expect(denied.srcdoc).toContain('data-yozz-withheld=""');
    expect(denied.srcdoc).toContain('title="Load remote images"');
    expect(denied.srcdoc).toContain('style="aspect-ratio:600/200"');
    expect(denied.srcdoc).toContain('img[data-yozz-withheld]{');

    const allowed = buildMailFrame(html, { allowRemoteImages: true });
    expect(allowed.srcdoc).not.toContain('data-yozz-withheld=""');
    expect(allowed.srcdoc).not.toContain('title="Load remote images"');
  });

  it('leaves a tracking pixel and an unsized image invisible, keeping any inline layout', () => {
    const { srcdoc } = blocked(
      '<img src="https://t.example/p.gif" width="1" height="1"><img src="https://t.example/q.gif"><img src="https://t.example/r.gif" width="300" height="100" style="display:block">',
    );
    expect(srcdoc.match(/data-yozz-withheld=""/g)).toHaveLength(1);
    expect(srcdoc).toContain('style="display:block;aspect-ratio:300/100"');
  });

  it('reads HTML dimensions: px suffixes give a ratio, a % width only a box', () => {
    const { srcdoc } = blocked(
      '<img src="https://t.example/a.gif" width="600px" height="200px"><img src="https://t.example/b.gif" width="100%" height="200">',
    );
    expect(srcdoc).toContain('style="aspect-ratio:600/200"');
    expect(srcdoc.match(/data-yozz-withheld=""/g)).toHaveLength(2);
    expect(srcdoc).not.toContain('aspect-ratio:100/200');
  });

  it('strips a sender-authored withheld marker so an inline picture cannot trigger consent', () => {
    const { srcdoc } = blocked(
      '<img src="data:image/gif;base64,R0lG" width="600" height="200" data-yozz-withheld>',
    );
    expect(srcdoc).not.toContain('data-yozz-withheld=""');
    expect(srcdoc).not.toContain('title="Load remote images"');
  });

  it('strips URL-bearing CSS declarations instead of widening remote-image consent', () => {
    const html = `<style>.hero{background:url(https://tracker.example/style.gif)}</style>
      <div style="color:red;background-image:url(//tracker.example/inline.gif)">x</div>
      <div style="background-image:u\\72l(https://tracker.example/escaped.gif)">y</div>`;
    for (const allowRemoteImages of [false, true]) {
      const frame = buildMailFrame(html, { allowRemoteImages });
      expect(frame.hasRemoteImages).toBe(false);
      expect(frame.srcdoc).not.toContain('tracker.example');
      expect(frame.srcdoc).toMatch(/color:\s*red/);
    }
  });

  it('drops an escaped CSS declaration without discarding safe siblings', () => {
    const frame = blocked(`<div style="color:red;margin:0;content:'\\201C'">x</div>`);
    expect(frame.srcdoc).toMatch(/color:\s*red/);
    expect(frame.srcdoc).toMatch(/margin:\s*0/);
    expect(frame.srcdoc).not.toContain('201C');
  });

  it('keeps layout rules from <style> blocks, including head ones, minus anything that fetches', () => {
    const html = `<!doctype html><html><head><title>Subject</title>
      <style>@import url(https://tracker.example/i.css);
      @font-face{font-family:f;src:url(https://tracker.example/f.woff)}
      .wrap{max-width:600px;margin:0 auto;background:url(https://tracker.example/bg.gif);color:red}
      @media (max-width:600px){.wrap{width:100%}}</style></head>
      <body><style>.foot{color:gray}</style><div class="wrap">x</div></body></html>`;
    const { srcdoc } = buildMailFrame(html, { allowRemoteImages: true });
    expect(srcdoc).not.toContain('tracker.example');
    expect(srcdoc).not.toContain('@import');
    expect(srcdoc).not.toContain('@font-face');
    expect(srcdoc).not.toContain('Subject');
    expect(srcdoc).toMatch(/\.wrap\{[^}]*max-width:\s*600px/);
    expect(srcdoc).toMatch(/\.wrap\{[^}]*color:\s*red/);
    expect(srcdoc).toMatch(/@media \(max-width:\s*600px\)\{\.wrap\{width:\s*100%/);
    expect(srcdoc).toMatch(/\.foot\{color:\s*gray/);
  });

  it('is dark only for mail that declares no colours, and honours dark-scheme rules', () => {
    expect(blocked('<p>Hi</p>').srcdoc).toContain(':root{color-scheme:dark}');
    // One side of the pair set: the sender authored against white, so white it gets.
    expect(blocked('<div style="color:#1f2430">Hi</div>').srcdoc).toContain(
      ':root{color-scheme:light}body{background:#fff',
    );
    expect(blocked('<table bgcolor="#ffffff"><tr><td>Hi</td></tr></table>').srcdoc).toContain(
      'color-scheme:light',
    );
    expect(blocked('<style>.x{background:#fff}</style><p class="x">Hi</p>').srcdoc).toContain(
      'color-scheme:light',
    );
    // Colours plus its own dark-scheme rules: built for both, so dark, with the query resolved.
    const { srcdoc } = blocked(`<style>
      .wrap{background:#fff;color:#000}
      @media (prefers-color-scheme: dark){.wrap{background:#000}}
      @media screen and (prefers-color-scheme:light){.wrap{background:#fff}}
    </style><div class="wrap">x</div>`);
    expect(srcdoc).toContain(':root{color-scheme:dark}');
    expect(srcdoc).not.toContain('prefers-color-scheme');
    expect(srcdoc).toMatch(/@media \(min-width:\s*0(?:px)?\)\{\.wrap\{background:/);
    expect(srcdoc).toMatch(/@media screen and \(max-width:\s*0(?:px)?\)\{\.wrap\{background:/);
  });

  it("leaves a light frame's prefers-color-scheme queries alone", () => {
    const { srcdoc } = blocked(
      '<style>.x{color:#000}@media (prefers-color-scheme: light){.x{color:#111}}</style><p class="x">x</p>',
    );
    expect(srcdoc).toContain('color-scheme:light');
    expect(srcdoc).toContain('(prefers-color-scheme: light)');
  });

  it('cannot end its own <style> from a selector that decodes to a closing tag', () => {
    const { srcdoc } = blocked(
      `<style>[x="<\\2f style><a id=pwn href=https://yozz.app/x>y<\\2f a><style>"]{color:red}</style><p>z</p>`,
    );
    expect(srcdoc.match(/<\/style>/g)).toHaveLength(2);
    const document = new DOMParser().parseFromString(srcdoc, 'text/html');
    expect(document.querySelector('#pwn')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe('z');
    // jsdom keeps the selector's escapes; browsers decode them, which the html:security gate covers.
    expect(srcdoc).toContain('\\3c ');
  });

  it('shows a blocked remote image as a transparent placeholder, not a broken image', () => {
    const { srcdoc } = blocked(
      '<img src="https://tracker.example/logo.png" width="40" alt="Logo">',
    );
    expect(srcdoc).toMatch(/<img src="data:image\/gif;base64,[^"]+" width="40" alt="Logo"[^>]*>/);
  });

  it('has no remote images to offer on a text-and-links body', () => {
    expect(blocked('<p><a href="https://example.com">x</a></p>').hasRemoteImages).toBe(false);
  });

  it('canonicalises outward links and opens them with no opener or referrer', () => {
    const { srcdoc } = blocked(
      '<a href="//example.com/a/../b">link</a><map><area href="mailto:x@example.com" shape="default"></map>',
    );
    expect(srcdoc).toContain('href="https://example.com/b"');
    expect(srcdoc).toContain('href="mailto:x@example.com"');
    expect(srcdoc.match(/target="_blank"/g)).toHaveLength(2);
    expect(srcdoc.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(srcdoc.match(/referrerpolicy="no-referrer"/g)).toHaveLength(2);
  });

  it('normalises folded URL attributes before validating them', () => {
    const frame = buildMailFrame(
      `<a href="https://example.com/very/\tlong\n/path">link</a>
      <img src="https://tracker.example/pix\r\n.gif">`,
      { allowRemoteImages: true },
    );
    expect(frame.srcdoc).toContain('href="https://example.com/very/long/path"');
    expect(frame.srcdoc).toContain('src="https://tracker.example/pix.gif"');
    expect(frame.hasRemoteImages).toBe(true);
  });

  it.each([
    ['/settings/delete', 'relative'],
    ['https:settings/delete', 'slashless https'],
    ['https:\\evil.example/delete', 'backslash https'],
    ['https://visible.example@evil.example/delete', 'credentials'],
    ['https://yozz.app/settings/delete', 'app origin'],
    ['https://api.yozz.app/api/v1/delete', 'API origin'],
    ['https://sub.yozz.app/delete', 'app subdomain'],
    ['https://yozz.app./settings/delete', 'app origin with DNS root dot'],
    ['https://ev%22il.example/delete', 'CSP-unsafe hostname'],
    ['https://exa\u000bmple.com/delete', 'non-normalizable control'],
    ['javascript:alert(1)', 'script URL'],
  ])('removes %s (%s)', (href, _label) => {
    const { srcdoc } = blocked(`<a href="${href}">destination</a>`);
    expect(srcdoc).toContain('destination');
    expect(srcdoc).not.toContain('<a href=');
    expect(srcdoc).toContain('title="Link unavailable in YOZZ"');
  });

  it('keeps only encrypted, credential-free remote image URLs', () => {
    const html = `<img src="http://plain.example/x.gif">
      <img src="/app-origin.gif">
      <img src="https://visible.example@evil.example/x.gif">
      <img src="https://yozz.app/session.gif">
      <img src="https://yozz.app./session.gif">
      <img src="https://ev%22il.example/injected.gif">
      <img src="https://a;b.example/injected.gif">
      <img srcset="https://tracker.example/a 1x" src="//tracker.example/b.gif">`;
    const allowed = buildMailFrame(html, { allowRemoteImages: true });
    expect(allowed.srcdoc).not.toContain('plain.example');
    expect(allowed.srcdoc).not.toContain('app-origin');
    expect(allowed.srcdoc).not.toContain('evil.example');
    expect(allowed.srcdoc).not.toContain('yozz.app/session');
    expect(allowed.srcdoc).not.toContain('srcset');
    expect(allowed.srcdoc).toContain('https://tracker.example/b.gif');
    expect(allowed.hasRemoteImages).toBe(true);
  });

  it('does not treat unrelated img attributes as remote-image carriers', () => {
    const frame = blocked(
      `<img href="https://tracker.example/href.gif"
        poster="https://tracker.example/poster.gif"
        background="https://tracker.example/background.gif">`,
    );
    expect(frame.hasRemoteImages).toBe(false);
    expect(frame.srcdoc).not.toContain('tracker.example');
  });

  it('caps distinct remote image origins admitted to one frame', () => {
    const html = Array.from(
      { length: 65 },
      (_, index) => `<img src="https://images-${index}.example/pixel.gif">`,
    ).join('');
    const allowed = buildMailFrame(html, { allowRemoteImages: true });
    expect(allowed.srcdoc).toContain('images-63.example');
    expect(allowed.srcdoc).not.toContain('images-64.example');
    expect(allowed.remoteImagesTruncated).toBe(true);
  });

  it('keeps safe raster data images and drops active or unknown data media', () => {
    const { srcdoc } = blocked(
      `<img src="data:image/png;base64,iVBORw0=">
      <img src="data:image/jpg;base64,iVBORw0=">
      <img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;">
      <video poster="data:image/png;base64,iVBORw0="></video>`,
    );
    expect(srcdoc).toContain('data:image/png;base64,iVBORw0=');
    expect(srcdoc).toContain('data:image/jpg;base64,iVBORw0=');
    expect(srcdoc).not.toContain('onload');
    expect(srcdoc).not.toContain('<video');
  });

  it('drops forms and metadata tags', () => {
    const { srcdoc } = blocked(
      `<form action="https://evil.example"><input name="password"></form>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <base href="https://evil.example/">`,
    );
    expect(srcdoc).not.toContain('evil.example');
    expect(srcdoc).not.toContain('<input');
  });

  it('sets no base and a document-wide no-referrer policy', () => {
    const { srcdoc } = blocked('<p>x</p>');
    expect(srcdoc).toContain('<meta name="referrer" content="no-referrer">');
    expect(srcdoc).not.toContain('<base');
  });

  it('nonces the measuring script freshly per frame', () => {
    const a = blocked('<p>x</p>');
    const b = blocked('<p>x</p>');
    const nonceOf = (srcdoc: string) => srcdoc.match(/nonce-([0-9a-f-]+)/)?.[1];
    expect(nonceOf(a.srcdoc)).toBeDefined();
    expect(nonceOf(a.srcdoc)).not.toBe(nonceOf(b.srcdoc));
  });

  it('keeps the host CSP hash aligned with the exact measuring script', () => {
    const { srcdoc } = blocked('<p>x</p>');
    const script = srcdoc.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    if (script === undefined) throw new Error('measuring script not found');
    const hash = createHash('sha256').update(script).digest('base64');
    const headers = readFileSync('public/_headers', 'utf8');
    expect(headers).toContain(`'sha256-${hash}'`);
  });
});
