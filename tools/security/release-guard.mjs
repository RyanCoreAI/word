import { readdir } from 'node:fs/promises';
import path from 'node:path';

// A publication boundary, not a general-purpose secret scanner. Never read file contents.
export async function assertPublicReleaseTree(root) {
  let files = 0;
  async function inspect(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Public release contains a non-regular entry: ${relative}`);
      const permittedMetadata = relative === '.well-known' && entry.isDirectory() || relative === '.nojekyll' && entry.isFile();
      if (entry.name.startsWith('.') && !permittedMetadata) throw new Error(`Public release contains a private/hidden entry: ${relative}`);
      if (/(?:\.(?:p12|pfx|pem|key|keystore|jks|sqlite3?|db|sql|dump|bak|backup|map)|\.env(?:\..*)?)$/i.test(entry.name)) throw new Error(`Public release contains a private/development file: ${relative}`);
      if (/\.json$/i.test(entry.name) && /(?:^|[-_.])(?:backup|user-state|progress)(?:[-_.]|$)/i.test(entry.name)) throw new Error(`Public release contains a possible personal backup: ${relative}`);
      if (entry.isDirectory()) await inspect(path.join(folder, entry.name), relative + '/');
      else files += 1;
    }
  }
  await inspect(path.resolve(root));
  return { files };
}
