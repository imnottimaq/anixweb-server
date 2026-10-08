import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../protocol/index.ts', import.meta.url), 'utf8');
await writeFile(new URL('../../anixweb/src/shared/roomProtocol.ts', import.meta.url), source);
console.log('Synced v2 protocol to anixweb/src/shared/roomProtocol.ts');
