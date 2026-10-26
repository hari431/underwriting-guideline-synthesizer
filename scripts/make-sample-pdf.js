// Generate the synthetic text-based guideline fixture PDF.
// Usage: npm run sample  (writes fixtures/sample-guideline.pdf)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../src/pdf-write.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'fixtures', 'sample-guideline.pdf');

const pages = [
  [
    'UNDERWRITEIQ SYNTHETIC GUIDELINE - ACME PERSONAL AUTO (DEMO DATA)',
    'Page 1 of 3 - Section 1: Base Rates by Driver Class',
    '',
    'Table 1 - Base Rate by Driver Class (annual, $)',
    'Driver Class | Base Rate',
    'Preferred | 480',
    'Standard | 620',
    'High Risk | 940',
    '',
    'Routine B1 - Base premium formula:',
    'base_premium = base_rate * territory_factor',
    'Evidence: Section 1 formula box, applies to all new business.',
  ],
  [
    'Page 2 of 3 - Section 2: Territory Factors',
    '',
    'Table 2 - Territory Factor (2026 schedule)',
    'Territory | Factor',
    'T01 Urban Core | 1.35',
    'T02 Suburban North | 1.10',
    'T03 Rural \u2013 South | 0.92',
    '',
    'Routine T1 - Territory eligibility condition:',
    'IF territory IN (T01, T02, T03) THEN apply Table 2 factor',
    'ELSE refer to underwriter (code REF-TERR).',
  ],
  [
    'Page 3 of 3 - Section 3: Final Premium Calculation',
    '',
    'Routine F1 - Final premium calculation steps:',
    'Step 1: Look up base_rate from Table 1 using driver class.',
    'Step 2: Look up territory_factor from Table 2 using territory.',
    'Step 3: final_premium = base_premium + policy_fee, where policy_fee = 25.',
    'Step 4: Round final_premium to the nearest dollar.',
    '',
    'Dependencies: F1 depends on B1 (base premium) and T1 (territory check).',
    'Routine G1 - Legacy surcharge note: APPLY legacy_matrix_v2 surcharge curve.',
  ],
];

const pdf = buildPdf(pages, { compress: true });
await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, pdf);
console.log(`wrote ${outFile} (${pdf.length} bytes, ${pages.length} pages)`);
