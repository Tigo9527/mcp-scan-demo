import { describe, expect, it, vi } from 'vitest';
import { executeOperation, findOperation, loadRegistry, operationSchemaInfo, searchOperations } from '../src/mcp/registry.js';

it('separates Core and eSpace and exposes schemas', () => {
  expect(searchOperations('', 'core').length).toBe(4);
  expect(searchOperations('', 'evm').map((x) => x.id)).toContain('evm.list_transactions');
  expect(operationSchemaInfo(findOperation('core.list_cfx_transfers')!).inputSchema.required).toContain('account');
  expect(loadRegistry().length).toBe(5);
});

it('validates arguments and calls only the configured upstream URL', async () => {
  const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ code: 0, data: ['ok'] }) }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const op = findOperation('core.list_cfx_transfers')!;
    await expect(executeOperation(op, {})).rejects.toThrow('Missing parameter');
    await expect(executeOperation(op, { account: 'cfx:x', limit: 101 })).rejects.toThrow('out of range');
    await expect(executeOperation(op, { account: 'cfx:x', minEpochNumber: 10, maxEpochNumber: 5 })).rejects.toThrow('minEpochNumber');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(executeOperation(op, { account: 'cfx:x' })).resolves.toMatchObject({ data: ['ok'] });
    const url = new URL(fetchMock.mock.calls[0]![0] as unknown as string);
    expect(url.host).toBe('api.confluxscan.org');
    expect(url.searchParams.get('account')).toBe('cfx:x');
    expect(url.searchParams.get('limit')).toBe('10');
  } finally { vi.unstubAllGlobals(); }
});
