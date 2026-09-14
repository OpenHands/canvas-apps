import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const text = readFileSync(process.argv[2], 'utf8');
assert.match(text, /export\s*\{[^}]*activate/);
assert.doesNotMatch(text, /\bimport\s*(?:\(|["']|[^;]*?\sfrom\s*["'])/);
for (const marker of ['Kanban Manager backend', 'SQLite', 'Backend setup']) assert.ok(text.includes(marker));
assert.ok(!text.includes('openhands-backends'), 'Browser must not extract Canvas credentials');
console.log('Validated self-contained React App artifact');
