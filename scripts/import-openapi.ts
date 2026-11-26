/** Import read-only OpenAPI operations into the local Registry.
 * Usage: npx tsx scripts/import-openapi.ts <spec.json|url> <core|evm> <base-url-env> [price]
 * Review registry/apis.json before deploying; this script changes trusted server configuration.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, space, baseUrlEnv, priceArg] = process.argv.slice(2);
if (!source || !['core', 'evm'].includes(space) || !baseUrlEnv) {
  throw new Error('Usage: import-openapi <spec.json|url> <core|evm> <base-url-env> [price]');
}
const raw = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
const spec = JSON.parse(raw) as Record<string, any>;
const baseUrl = spec.servers?.[0]?.url ?? (spec.schemes?.[0] ?? 'https') + '://' + spec.host + (spec.basePath ?? '');
if (!URL.canParse(baseUrl)) throw new Error('OpenAPI spec has no absolute server URL');
const filename = resolve('registry/apis.json');
const registry = JSON.parse(readFileSync(filename, 'utf8')) as { operations: any[] };
const existing = new Set(registry.operations.map((op) => op.id));
let count = 0;
for (const [path, methods] of Object.entries(spec.paths ?? {}) as Array<[string, any]>) {
  for (const [method, operation] of Object.entries(methods) as Array<[string, any]>) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const name = operation.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
    const id = `${space}.${name}`;
    if (existing.has(id)) continue;
    const parameters: Record<string, unknown> = {};
    for (const p of [...(methods.parameters ?? []), ...(operation.parameters ?? [])]) {
      if (!p.name || !['path', 'query'].includes(p.in)) continue;
      const schema = p.schema ?? p;
      parameters[p.name] = { type: schema.type ?? 'string', description: p.description, required: Boolean(p.required || p.in === 'path'), in: p.in, default: schema.default, minimum: schema.minimum, maximum: schema.maximum, enum: schema.enum };
    }
    const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
    for (const [key, schema] of Object.entries(bodySchema?.properties ?? {}) as Array<[string, any]>) {
      parameters[key] = { type: schema.type ?? 'string', description: schema.description, required: Boolean(bodySchema.required?.includes(key)), in: 'body', default: schema.default, minimum: schema.minimum, maximum: schema.maximum, enum: schema.enum };
    }
    registry.operations.push({ id, space, description: operation.summary ?? operation.description ?? id, method: method.toUpperCase(), baseUrl, baseUrlEnv, path, parameters, price: Number(priceArg ?? 0) });
    existing.add(id); count++;
  }
}
writeFileSync(filename, JSON.stringify(registry, null, 2) + '\n');
console.log(`Imported ${count} operations into ${filename}`);
