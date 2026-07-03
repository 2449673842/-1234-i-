import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const arch = require('archiver');
console.log('Under TSX:');
console.log('Type of arch:', typeof arch);
console.log('Is arch callable?', typeof arch === 'function');
console.log('Keys of arch:', Object.keys(arch));
console.log('arch.ZipArchive:', typeof arch.ZipArchive);
try {
  const archive = new arch.ZipArchive({ zlib: { level: 9 } });
  console.log('ZipArchive instantiation worked!');
} catch (e) {
  console.log('ZipArchive instantiation failed:', e.message);
}
try {
  const archive = arch({ zlib: { level: 9 } });
  console.log('Calling arch(...) as function worked!');
} catch (e) {
  console.log('Calling arch(...) as function failed:', e.message);
}
