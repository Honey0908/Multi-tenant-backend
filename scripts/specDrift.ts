import request from 'supertest';
import YAML from 'yamljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';

/**
 * Checks that every operation in docs/openapi.yaml is actually served
 * (`npm run audit:spec`).
 *
 * The spec is the contract the frontend generates its API client from, so a
 * documented-but-missing endpoint is the dangerous kind of drift: the
 * generated client still compiles and only fails in the browser, at runtime.
 *
 * It probes the running app over HTTP rather than reading Express's router
 * internals — those are private and changed shape in Express 5, and an
 * outside-in check is what a real client experiences anyway. Unknown routes
 * fall through to the catch-all 404 handler in src/app.ts, which is the
 * signal this looks for; any other status (401, 400, 404-from-a-handler)
 * means the route exists.
 *
 * It also validates the spec's own shape. A spec can be perfectly routable
 * and still generate a broken client: a path parameter the operation never
 * declares, or a `parameters:` list that parsed to null because of a
 * duplicate YAML key, both produce a client that silently drops arguments.
 * Those are invisible to a "does this route answer" check, so they are
 * checked directly here.
 *
 * Note the routing check is one-directional: it cannot detect a served route
 * that nobody documented, since there is no way to enumerate those from
 * outside.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spec = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));

const SAMPLE_UUID = '00000000-0000-0000-0000-000000000000';

async function probe(method: string, specPath: string): Promise<boolean> {
  const url = '/api' + specPath.replace(/\{[A-Za-z]+\}/g, SAMPLE_UUID);
  const agent = request(app) as unknown as Record<string, (u: string) => request.Test>;
  const res = await agent[method.toLowerCase()]!(url).send();
  // The catch-all in src/app.ts is the only thing that produces this exact body.
  return !(res.status === 404 && res.body?.message === 'Route not found');
}

interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
}

/** Resolves a parameter that may be a $ref into components.parameters. */
function resolveParameter(spec: SpecShape, parameter: ParameterObject): ParameterObject {
  if (!parameter.$ref) return parameter;
  const name = parameter.$ref.split('/').pop() ?? '';
  return spec.components?.parameters?.[name] ?? {};
}

interface SpecShape {
  paths: Record<string, Record<string, { operationId?: string; parameters?: ParameterObject[] | null }>>;
  components?: { parameters?: Record<string, ParameterObject> };
}

/**
 * Every `{placeholder}` in a path must be declared by the operation as an
 * `in: path` parameter *under the same name*. A mismatch (say a path of
 * {orgId} declaring a parameter named `id`) generates a client that never
 * fills that segment in.
 */
function checkPathParameters(spec: SpecShape): string[] {
  const problems: string[] = [];

  for (const [route, item] of Object.entries(spec.paths)) {
    const placeholders = [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const shared = (item as { parameters?: ParameterObject[] }).parameters ?? [];

    for (const [method, operation] of Object.entries(item)) {
      if (method === 'parameters' || typeof operation !== 'object' || operation === null) continue;

      // A null list means the key exists but parsed to nothing — the
      // signature of a duplicate `parameters:` key in the YAML.
      if ('parameters' in operation && operation.parameters === null) {
        problems.push(`${method.toUpperCase()} ${route}: parameters is null (duplicate YAML key?)`);
        continue;
      }

      const declared = new Set(
        [...(operation.parameters ?? []), ...shared]
          .map((parameter) => resolveParameter(spec, parameter))
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name),
      );

      for (const placeholder of placeholders) {
        if (!declared.has(placeholder)) {
          problems.push(
            `${method.toUpperCase()} ${route}: path needs {${placeholder}} but the operation declares [${[...declared].join(', ')}]`,
          );
        }
      }
    }
  }
  return problems;
}

async function main() {
  const operations: Array<{ method: string; path: string; operationId?: string }> = [];
  for (const [specPath, item] of Object.entries(spec.paths as Record<string, Record<string, { operationId?: string }>>)) {
    for (const [method, op] of Object.entries(item)) {
      operations.push({ method, path: specPath, operationId: op.operationId });
    }
  }

  const missing: string[] = [];
  const noOperationId: string[] = [];

  for (const op of operations) {
    if (!op.operationId) {
      noOperationId.push(`${op.method.toUpperCase()} ${op.path}`);
    }
    if (!(await probe(op.method, op.path))) {
      missing.push(`${op.method.toUpperCase()} ${op.path}`);
    }
  }

  const parameterProblems = checkPathParameters(spec as SpecShape);

  console.log(`Documented operations: ${operations.length}`);

  if (parameterProblems.length > 0) {
    console.error(`\nPath parameter problems (${parameterProblems.length}) — generated clients drop these arguments:`);
    for (const entry of parameterProblems) console.error(`  ${entry}`);
  }

  if (noOperationId.length > 0) {
    console.error(`\nMissing operationId (${noOperationId.length}) — generated clients get unstable names:`);
    for (const entry of noOperationId) console.error(`  ${entry}`);
  }
  if (missing.length > 0) {
    console.error(`\nDocumented but NOT served (${missing.length}) — generated clients would 404:`);
    for (const entry of missing) console.error(`  ${entry}`);
  }

  if (missing.length === 0 && noOperationId.length === 0 && parameterProblems.length === 0) {
    console.log(
      'Spec audit passed: every documented operation is served, has an operationId, and declares its path parameters.',
    );
    return;
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
