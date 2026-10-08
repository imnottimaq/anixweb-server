import test from 'node:test';
import assert from 'node:assert/strict';
import { businessLog } from '../src/logging.ts';

test('business logging includes only fixed fields and bounds repeated output', () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = value => messages.push(value);
  try {
    businessLog('command_rejected', { roomId: 'room', code: 'CONTROL_REQUIRED', token: 'must-not-be-logged', profileId: 123, url: 'https://example.invalid?ticket=secret' } as never);
    assert.deepEqual(JSON.parse(messages[0]), { event: 'command_rejected', roomId: 'room', code: 'CONTROL_REQUIRED' });
    for (let i = 0; i < 100; i++) businessLog('connected', { roomId: 'room' });
    assert.equal(messages.length, 60);
    assert.ok(messages.every(value => !value.includes('secret') && !value.includes('profileId')));
  } finally { console.info = original; }
});
