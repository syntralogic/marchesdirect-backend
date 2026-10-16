# Part 8 – Company database export (CSV + Excel)

Both files are generated from one column definition (`EXPORT_COLUMNS` in `src/services/prospectExport.ts`), so the table, the CSV and the Excel file cannot disagree.

## What is in the files
- 45 columns: identifiers (SIRET, SIREN), identity and legal data, NAF activity and métier, address and GPS, phone, e-mail, website, Facebook / Instagram / LinkedIn, directors, headcount range, revenue and net result, certifications, history, Google profile link, rating, total reviews, positive reviews (count / %), match confidence, Place ID, per-field sources and per-field status of empty cells.
- Excel also has a **Légende** sheet: export date, row count, applied filters, description and source of every column, and the fields that need another provider.

## Format rules
- CSV: UTF-8 with BOM, `;` separator, decimal comma, CRLF, text quoted, empty = empty cell.
- Identifier columns (SIRET, SIREN, code postal, département, téléphone) are written as `="…"` in the CSV so Excel keeps leading zeros and never shows scientific notation. In the .xlsx they are plain text cells.
- Excel: typed dates (dd/mm/yyyy), numbers, clickable links, frozen header and first 4 columns, autofilter. Limit 200,000 rows (use CSV or narrow filters beyond that).
- Text starting with `= + - @` is neutralised against formula injection (both formats).

## Known limits (never filled with estimates)
- Positive-review count / % : Google Places does not expose the star distribution. Columns are present and empty, with status "indisponible", until a licensed review provider is approved.
- Revenue, directors, headcount, certifications: only when published in the registry; otherwise status "absent, confirmé".
- E-mail, Facebook, Instagram, LinkedIn: only links the company publishes on its own site.

## Verification
`src/services/__tests__/prospectExport.test.ts` writes both formats for representative records (full, sparse/closed, formula-like name, accents, negative result) and checks: headers, BOM, cell-by-cell CSV = Excel equality, leading zeros, French characters, empty-value handling, Légende content, and that every column is documented.
Not covered here: the PostgreSQL-backed suites (skipped without a database) and a real download from the deployed admin page.
