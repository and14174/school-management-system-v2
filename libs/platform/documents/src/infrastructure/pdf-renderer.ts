import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { chromium, type Browser } from 'playwright';

/**
 * Chromium is expensive to start (see the module report for a measured
 * cold-launch vs. warm-render time). One browser instance is launched lazily
 * on the first render and reused for the life of the process; a `page` is
 * opened and closed per render, which is cheap. `onModuleDestroy` closes the
 * shared browser on graceful shutdown so the process does not leak a
 * Chromium subprocess.
 */
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private browserPromise: Promise<Browser> | undefined;

  private getBrowser(): Promise<Browser> {
    this.browserPromise ??= chromium.launch({ headless: true });
    return this.browserPromise;
  }

  /**
   * Renders `html` (a complete, self-contained HTML document - no external
   * fetches, see `DocumentTemplate`'s own doc comment) to a PDF buffer.
   */
  async renderToPdf(html: string): Promise<{ buffer: Buffer; pageCount: number }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      // 'load' rather than 'networkidle': the content is inlined (no
      // external requests to go idle waiting for), and networkidle adds a
      // fixed settle delay for nothing in return.
      await page.setContent(html, { waitUntil: 'load' });
      const buffer = await page.pdf({ format: 'A4', printBackground: true });
      return { buffer, pageCount: countPdfPages(buffer) };
    } finally {
      await page.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise;
    this.browserPromise = undefined;
    await browser.close();
  }
}

/**
 * Playwright's `page.pdf()` returns bytes, not a page count. The page
 * `/Count` for a PDF's top-level `/Pages` node is plain (uncompressed) text
 * in Chromium's printToPDF output even though individual page CONTENT
 * streams are Flate-compressed, so a direct regex read is reliable without
 * pulling in a full PDF-parsing dependency this module was not asked to add.
 * Falls back to 1 if the marker is ever absent (never observed empirically -
 * see the module report - but a wrong page count must never throw).
 */
function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString('latin1');
  const match = /\/Type\s*\/Pages[^e][\s\S]{0,200}?\/Count\s+(\d+)/.exec(text) ?? /\/Count\s+(\d+)/.exec(text);
  if (!match) return 1;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : 1;
}
