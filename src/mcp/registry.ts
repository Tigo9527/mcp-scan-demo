import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const operationSchema = z.object({
  id: z.string().min(1),
  space: z.enum(['core', 'evm']),
  description: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  baseUrl: z.string().url(),
  baseUrlEnv: z.string().optional(),
  path: z.string().startsWith('/'),
  parameters: z.record(z.object({ type: z.enum(['string', 'number', 'integer', 'boolean']), description: z.string().optional(), required: z.boolean().optional(), default: z.unknown().optional(), minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(z.string()).optional(), in: z.enum(['path', 'query', 'body']).optional() })),
  fixedQuery: z.record(z.string()).optional(),
  orderedRanges: z.array(z.tuple([z.string(), z.string()])).optional(),
  headers: z.record(z.string()).optional(),
  auth: z.object({ header: z.string(), env: z.string(), prefix: z.string().optional() }).optional(),
  price: z.number().nonnegative().optional(),
});
export type Operation = z.infer<typeof operationSchema>;
const registrySchema = z.object({ operations: z.array(operationSchema) });
const registryPath = () => resolve(process.env.MCP_API_REGISTRY ?? 'registry/apis.json');

/** Registry is read on each call so adding an operation does not require a release or restart. */
export function loadRegistry(): Operation[] {
  const parsed = registrySchema.parse(JSON.parse(readFileSync(registryPath(), 'utf8')));
  const ids = new Set<string>();
  for (const op of parsed.operations) {
    if (ids.has(op.id)) throw new Error(`Duplicate API id: ${op.id}`);
    ids.add(op.id);
  }
  return parsed.operations;
}
export function findOperation(id: string): Operation | undefined { return loadRegistry().find((op) => op.id === id); }
export function searchOperations(query = '', space?: 'core' | 'evm'): Array<Pick<Operation, 'id' | 'space' | 'description' | 'price'>> {
  const q = query.trim().toLowerCase();
  return loadRegistry().filter((op) => (!space || op.space === space) && (!q || `${op.id} ${op.description}`.toLowerCase().includes(q)))
    .map(({ id, space: s, description, price }) => ({ id, space: s, description, price }));
}
export function operationSchemaInfo(op: Operation) {
  return { id: op.id, space: op.space, description: op.description, method: op.method, path: op.path, price: op.price ?? 0,
    inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(op.parameters).map(([key, p]) => [key, { type: p.type, description: p.description, default: p.default, minimum: p.minimum, maximum: p.maximum, enum: p.enum }])), required: Object.entries(op.parameters).filter(([, p]) => p.required).map(([key]) => key) } };
}
export async function executeOperation(op: Operation, input: Record<string, unknown>): Promise<unknown> {
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(input)) if (!(key in op.parameters)) throw new Error(`Unknown parameter: ${key}`);
  for (const [key, p] of Object.entries(op.parameters)) {
    const value = input[key] ?? p.default;
    if (value === undefined || value === null) { if (p.required) throw new Error(`Missing parameter: ${key}`); continue; }
    if (p.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be nonempty string`);
    if (p.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    if ((p.type === 'number' || p.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || (p.type === 'integer' && !Number.isInteger(value)))) throw new Error(`${key} must be ${p.type}`);
    if (typeof value === 'number' && ((p.minimum !== undefined && value < p.minimum) || (p.maximum !== undefined && value > p.maximum))) throw new Error(`${key} out of range`);
    if (p.enum && !p.enum.includes(String(value))) throw new Error(`${key} invalid value`);
    args[key] = value;
  }
  for (const [min, max] of op.orderedRanges ?? []) {
    if (args[min] !== undefined && args[max] !== undefined && Number(args[min]) > Number(args[max])) throw new Error(`${min} cannot exceed ${max}`);
  }
  const base = op.baseUrlEnv && process.env[op.baseUrlEnv] || op.baseUrl;
  const url = new URL(base);
  let path = op.path;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const where = op.parameters[key]!.in ?? 'query';
    if (where === 'path') path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    else if (where === 'body') body[key] = value;
    else url.searchParams.set(key, String(value));
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('Unresolved path parameter');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  for (const [key, value] of Object.entries(op.fixedQuery ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = { Accept: 'application/json', ...op.headers };
  if (op.auth) { const secret = process.env[op.auth.env]; if (!secret) throw new Error(`Upstream credential not configured: ${op.auth.env}`); headers[op.auth.header] = `${op.auth.prefix ?? ''}${secret}`; }
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(op.method);
  if (hasBody) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method: op.method, headers, body: hasBody ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload && typeof payload === 'object') {
    if ('code' in payload && payload.code !== 0) throw new Error(`Upstream API error ${payload.code}: ${String(payload.message ?? '')}`);
    if ('status' in payload && payload.status !== '1') throw new Error(`Upstream API error ${payload.status}: ${String(payload.message ?? '')}`);
  }
  return payload;
}
