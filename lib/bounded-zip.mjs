import { fromBuffer } from 'yauzl';

/**
 * @param {Buffer} buffer
 * @param {import('./document-archive.server').ZipLimits} [limits]
 * @returns {Promise<Map<string, Buffer>>}
 */
async function readZipEntries(buffer, {
  select = () => true,
  maxEntryBytes = 16 * 1024 * 1024,
  maxTotalBytes = 48 * 1024 * 1024,
  maxEntries = 1024,
  signal,
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error('Invalid ZIP'));
        return;
      }
      const entries = new Map();
      const names = new Set();
      let total = 0;
      let closed = false;
      function finish(error) {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', abort);
        zip.close();
        if (error) reject(error);
        else resolve(entries);
      }
      function abort() {
        finish(signal?.reason instanceof Error ? signal.reason : new Error('ZIP processing aborted'));
      }
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (names.has(name) || names.size >= maxEntries) {
          finish(new Error('ZIP entry limit exceeded'));
          return;
        }
        names.add(name);
        if (name.endsWith('/') || !select(name)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > maxEntryBytes || total + entry.uncompressedSize > maxTotalBytes) {
          finish(new Error('Expanded ZIP size limit exceeded'));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            finish(error || new Error('Cannot read ZIP entry'));
            return;
          }
          const chunks = [];
          let size = 0;
          stream.on('error', finish);
          stream.on('data', (chunk) => {
            size += chunk.length;
            if (closed || size > maxEntryBytes || total + size > maxTotalBytes) {
              stream.destroy();
              finish(new Error('Expanded ZIP size limit exceeded'));
            } else {
              chunks.push(chunk);
            }
          });
          stream.on('end', () => {
            if (closed) return;
            total += size;
            entries.set(name, Buffer.concat(chunks, size));
            zip.readEntry();
          });
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (zip.entryCount > maxEntries) finish(new Error('ZIP entry limit exceeded'));
      else zip.readEntry();
    });
  });
}

export { readZipEntries };
