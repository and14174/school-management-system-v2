import { z } from 'zod';
import type { DocumentTemplate } from './types.js';

/**
 * Ships INSIDE this module (unlike a real report card, which must be
 * registered by `apps/api` - see `types.ts`) because it references no domain
 * concept at all: a certificate needs nothing but a name, an achievement and
 * a date. Used by this module's own test suite (`documents.spec.ts`) and
 * registered by `apps/api`'s `DocumentTemplatesModule` as the one concrete
 * template available until a real domain module registers its own.
 */
const sampleCertificateDataSchema = z.object({
  recipientName: z.string().min(1),
  achievement: z.string().min(1),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'issuedOn must be a YYYY-MM-DD date'),
  issuer: z.string().min(1).default('School Management System'),
});

export type SampleCertificateData = z.infer<typeof sampleCertificateDataSchema>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const sampleCertificateTemplate: DocumentTemplate<SampleCertificateData> = {
  key: 'sample-certificate',
  name: 'Sample Certificate',
  dataSchema: sampleCertificateDataSchema,

  async render(data) {
    const html = `
      <div class="certificate">
        <p class="eyebrow">Certificate of Achievement</p>
        <h1>${escapeHtml(data.recipientName)}</h1>
        <p class="lede">has achieved</p>
        <p class="achievement">${escapeHtml(data.achievement)}</p>
        <p class="issued">Issued ${escapeHtml(data.issuedOn)} by ${escapeHtml(data.issuer)}</p>
      </div>
    `;

    // Self-contained print CSS, no external fetches - see the module header.
    const css = `
      @page { size: A4 landscape; margin: 24mm; }
      body { font-family: Georgia, 'Times New Roman', serif; color: #1f2933; }
      .certificate { text-align: center; border: 4px solid #1f2933; padding: 48px; }
      .eyebrow { letter-spacing: 0.2em; text-transform: uppercase; font-size: 12px; color: #52606d; }
      h1 { font-size: 40px; margin: 16px 0; }
      .achievement { font-size: 24px; font-style: italic; margin: 24px 0; }
      .issued { font-size: 14px; color: #52606d; }
    `;

    return { html, css };
  },
};
