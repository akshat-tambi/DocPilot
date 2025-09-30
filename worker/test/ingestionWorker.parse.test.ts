import { EventEmitter } from 'node:events';
import type { MessagePort } from 'worker_threads';

import { describe, it, expect } from 'vitest';

import { IngestionWorker } from '../src/ingestionWorker';

class StubPort extends EventEmitter {
  postMessage(): void {}

  close(): void {}

  start(): void {}

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

function createWorker(): IngestionWorker {
  return new IngestionWorker(new StubPort() as unknown as MessagePort);
}

describe('IngestionWorker parsing helpers', () => {
  it('extracts headings, main content, and normalized links from HTML', () => {
    const worker = createWorker() as unknown as {
      parseHtml(url: string, html: string): {
        text: string;
        headings: string[];
        links: string[];
      };
    };

    const html = `
      <html>
        <body>
          <header><h1>Ignore me</h1></header>
          <main>
            <h2>Getting Started</h2>
            <p>Welcome to the docs!</p>
            <a href="/guide">Guide</a>
          </main>
          <footer>
            <a href="https://example.com/external">External</a>
          </footer>
        </body>
      </html>
    `;

    const result = worker.parseHtml('https://docs.example.com/start', html);

    expect(result.text).toContain('Getting Started');
    expect(result.text).toContain('Welcome to the docs!');
    expect(result.headings).toEqual(['Ignore me', 'Getting Started']);
    expect(result.links).toContain('https://docs.example.com/guide');
    expect(result.links).toContain('https://example.com/external');
  });

  it('falls back to body text and strips fragments when no main container is present', () => {
    const worker = createWorker() as unknown as {
      parseHtml(url: string, html: string): {
        text: string;
        headings: string[];
        links: string[];
      };
    };

    const html = `
      <html>
        <body>
          <h1>Overview</h1>
          <p>Body level details.</p>
          <a href="section/page.html#intro?query=1">Section</a>
        </body>
      </html>
    `;

    const result = worker.parseHtml('https://docs.example.com/root/', html);

    expect(result.text).toContain('Overview');
    expect(result.text).toContain('Body level details.');
    expect(result.headings).toEqual(['Overview']);
    expect(result.links).toEqual(['https://docs.example.com/root/section/page.html']);
  });

  it('normalizes markdown content to plain text without links array', async () => {
    const worker = createWorker() as unknown as {
      parseMarkdown(markdown: string): Promise<{
        text: string;
        headings: string[];
        links: string[];
      }>;
    };

    const markdown = `# Title\n\nSome *markdown* content with [a link](https://example.com).\n\n- bullet item`;

    const result = await worker.parseMarkdown(markdown);

    expect(result.text).toContain('Title');
    expect(result.text).toContain('Some markdown content with a link.');
    expect(result.text).toContain('bullet item');
    expect(result.headings).toEqual([]);
    expect(result.links).toEqual([]);
  });
});
