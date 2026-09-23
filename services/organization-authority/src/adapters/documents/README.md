# Document text extraction

The immutable original is stored independently of extraction. `extractDocument`
accepts original bytes, the filename and its SHA-256 provenance, then returns
bounded text chunks and an honest extraction status. It never invokes a model.
The caller persists the result only after checking its lease and custody policy.
Accepted shared documents continue processing after their contributor leaves;
private documents retain the exact contributor-tenure eligibility check.

Supported inputs are UTF-8 text/Markdown, PDF text layers, and ordinary Word
`.docx` files. Scanned or blank documents report `no_text`; OCR is not included.
Legacy `.doc` and encrypted Office compound containers are unsupported at
admission. Password-encrypted PDF and ZIP entries report `encrypted`.

The pinned parsers are PDF.js 6.3.289, Mammoth 1.12.3 and yauzl 3.4.0. PDF.js 6
removed JavaScript code generation. Only its text extraction APIs run; scripts,
rendering and document actions are never invoked. Mammoth receives a buffer with
its default-denied external file access and returns plain text, never HTML.
Network entry points are disabled in the worker before loading parsers.

One worker runs at a time. A second caller may wait; additional callers receive
`unavailable`. Each worker has a 256 MiB V8 old-generation heap budget, a 16 MiB
young-generation budget, and a 30-second deadline. Timeout and cancellation await
worker termination before another job starts. V8 heap limits do not impose a
hard process RSS or ArrayBuffer limit. Originals are capped at 25 MiB, and ZIP
expansion is independently bounded before the Word parser reads the archive.

DOCX preflight checks an exact single-disk central directory, at most 2,000
entries and 128 MiB declared and actual expanded bytes. It rejects mismatched
local headers, overlapping data, unsafe/duplicate paths, unsupported compression,
CRC errors, XML entity declarations and macro content. ZIP64 and UTF-16 XML are
not accepted by this first extractor. The original remains retained if extraction
cannot proceed.

Extracted text is capped at 2 MiB, 4,096 chunks, 3,072 UTF-8 bytes per chunk and
500 PDF pages. Truncation reports `partial` and retains source anchors. PDF
anchors are one-based page numbers; text/Word anchors are one-based extracted
paragraph ordinals, which are not document-layout page numbers. Consecutive text
lines and Word paragraphs share bounded chunks; each anchor identifies the first
paragraph included. PDF pages stay separate. Chunk boundaries preserve Unicode
and ordinary words. Word warnings about ignored elements produce `partial` with
the omission reason; cosmetic warnings alone do not. A single token longer than a whole chunk
necessarily spans chunks; chunk-local full-text search does not match phrases
across chunk boundaries.

Primary parser documentation:

- https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
- https://github.com/mwilliamson/mammoth.js/blob/master/README.md
- https://github.com/thejoshwolfe/yauzl/blob/master/README.md

Focused tests build valid synthetic PDF and DOCX containers and exercise real
parsers, encryption, malformed containers, expansion and text budgets, source
hashes, page/paragraph provenance, timeout and cancellation. Tests import the
built worker even when the caller is transformed directly from TypeScript.
