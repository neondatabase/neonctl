/* eslint-disable @typescript-eslint/no-non-null-asserted-optional-chain */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import SwaggerParser from '@apidevtools/swagger-parser';
import { createWriteStream } from 'node:fs';
import { OpenAPIV3 } from 'openapi-types';

const EXTRACT_PROPERTIES = [
  'ProjectCreateRequest',
  'ProjectUpdateRequest',
  'BranchCreateRequest',
  'BranchCreateRequestEndpointOptions',
  'BranchUpdateRequest',
  'EndpointCreateRequest',
  'EndpointUpdateRequest',
  'DatabaseCreateRequest',
  'RoleCreateRequest',
];

const typesMapping = {
  array: 'array',
  integer: 'number',
  string: 'string',
  boolean: 'boolean',
} as const;

// Explicitly mark the IIFE as void to satisfy no-floating-promises
void (async () => {
  const spec = (await SwaggerParser.dereference(
    './node_modules/@neondatabase/api-client/public-v2.yaml',
  )) as OpenAPIV3.Document;
  const outFile = createWriteStream('./src/parameters.gen.ts', 'utf8');
  outFile.write('// FILE IS GENERATED, DO NOT EDIT\n\n');
  EXTRACT_PROPERTIES.forEach((name) => {
    const schema = spec.components?.schemas?.[name] as OpenAPIV3.SchemaObject;
    const parseProperties = (
      schema: OpenAPIV3.SchemaObject,
      context: string[] = [],
    ) => {
      Object.entries(
        schema.properties as Record<string, OpenAPIV3.SchemaObject>,
      ).forEach(([key, value]) => {
        if (value.type === 'object' && value.properties) {
          parseProperties(value, [...context, key]);
        } else if (value.type && value.type in typesMapping) {
          outFile.write(
            `  '${[...context, key].join('.')}': {
              type: ${JSON.stringify(
                typesMapping[value.type as keyof typeof typesMapping],
              )},
              description: ${JSON.stringify(value.description)},
              demandOption: ${
                schema.required?.includes(key) ? 'true' : 'false'
              },\n`,
          );
          if (value.enum) {
            outFile.write(` choices: ${JSON.stringify(value.enum)},\n`);
          }
          outFile.write('  },\n');
        }
      });
    };
    outFile.write(
      `export const ${name[0].toLowerCase()}${name.slice(1)} = {\n`,
    );
    parseProperties(schema);
    outFile.write(`} as const;\n\n`);
  });
  outFile.end();
})();
