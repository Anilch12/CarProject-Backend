import yauzl from 'yauzl';
import { ApiError } from './errors.js';

// Inspect the ZIP directory before allowing the workbook parser to decompress it.
// Stream every entry with a hard actual-byte limit as well as the declared-size cap.
export async function validateWorkbookArchive(buffer: Buffer): Promise<void> {
  if (buffer.length > 2 * 1024 * 1024) throw new ApiError(422, 'IMPORT_TOO_LARGE', 'Workbook exceeds 2 MiB');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new ApiError(422, 'INVALID_WORKBOOK', 'Workbook is not a valid XLSX archive'));
      let count = 0, declared = 0, actual = 0, failed = false;
      const fail = () => { if (!failed) { failed = true; zip.close(); reject(new ApiError(422, 'UNSAFE_WORKBOOK', 'Workbook archive is invalid or exceeds 20 MiB expanded / 1000 files')); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(); });
      zip.on('entry', entry => {
        if (failed) return;
        declared += entry.uncompressedSize;
        if (++count > 1000 || declared > 20 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1)) return fail();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail();
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => { actual += chunk.length; if (actual > 20 * 1024 * 1024) { stream.destroy(); fail(); } });
          stream.on('end', () => { if (!failed) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
