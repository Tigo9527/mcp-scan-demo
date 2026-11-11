import assert from 'node:assert/strict';
import { parsePollDetails } from './task-client.mjs';
const content = '请访问 http://localhost:8003/api/agents/27195b55-2c07-4b83-875c-26a6cea71204/tasks/poll，请求头 X-Agent-Token: abc123。';
assert.deepEqual(parsePollDetails(content), { pollUrl: 'http://localhost:8003/api/agents/27195b55-2c07-4b83-875c-26a6cea71204/tasks/poll', pollToken: 'abc123' });
console.log('codex-agent-worker tests passed');
