/* eslint-disable no-console */
import * as ts from 'ts-morph';

import { createWriteStream } from 'fs';

const apiFile = new ts.Project({
  tsConfigFilePath: './node_modules/@neondatabase/api-client/tsconfig.json',
});

// Which interfaces to extract from generated API
const EXTRACT_PROPERTIES = ['ProjectCreateRequest'];

const apiSource = apiFile.getSourceFileOrThrow(
  './node_modules/@neondatabase/api-client/api.gen.ts'
);

type PropertyDeclaration = {
  name: string;
  type: string;
  description?: string;
  choices?: string[];
};

const convertProperties = (properties: ts.PropertySignature[]) => {
  const result = [] as PropertyDeclaration[];

  properties.forEach((property) => {
    const travereProperty = (s: ts.Symbol, ctx: string[]) => {
      const decl = s.getDeclarations()[0];
      let description = '';
      if (decl.isKind(ts.SyntaxKind.PropertySignature)) {
        description += decl.getJsDocs()[0]?.getCommentText();
      }

      if (decl.getType().isObject()) {
        decl
          .getType()
          .getProperties()
          .forEach((ns) => travereProperty(ns, [...ctx, s.getName()]));
      } else if (decl.getType().isEnum()) {
        result.push({
          name: [...ctx, s.getName()].join('.'),
          type: 'string',
          description,
          choices: decl
            .getType()
            .getUnionTypes()
            .map((t) => t.getLiteralValue()?.toString())
            .filter((v) => v !== undefined) as string[],
        });
      } else {
        result.push({
          description,
          name: [...ctx, s.getName()].join('.'),
          type: decl.getType().getText(),
        });
      }
    };
    const name = property.getName();
    const type = property.getType();
    if (type.isObject()) {
      type.getProperties().forEach((s) => travereProperty(s, [name]));
    } else {
      result.push({
        name,
        description: property.getLeadingCommentRanges()[0]?.getText(),
        type: type.getText(),
      });
    }
  });
  return result;
};

const outFile = createWriteStream('./src/parameters.gen.ts', 'utf8');
outFile.write('// FILE IS GENERATED, DO NOT EDIT\n\n');

EXTRACT_PROPERTIES.flatMap((p) => {
  console.log(`Extracting ${p}`);
  outFile.write(`export const ${p[0].toLowerCase()}${p.slice(1)} = {\n`);
  convertProperties(apiSource.getInterface(p)?.getProperties() ?? []).forEach(
    ({ name, type, choices, description }) => {
      outFile.write(`  '${name}': {\n`);
      outFile.write(`    type: '${type}',\n`);
      if (choices) {
        outFile.write(`    choices: ${JSON.stringify(choices)},\n`);
      }
      if (description) {
        outFile.write(`    description: ${JSON.stringify(description)},\n`);
      }
      outFile.write(`  },\n`);
    }
  );
  outFile.write('} as const;\n\n');
});

outFile.end();
