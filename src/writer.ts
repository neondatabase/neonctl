import YAML from 'yaml';
import Table from 'cli-table';
import chalk from 'chalk';

import { CommonProps } from './types.js';
import { isCi } from './env.js';
import { isObject, toSnakeCase } from './utils/string.js';

type ExtractFromArray<T> = T extends (infer R)[] ? R : T;
type OnlyStrings<T> = T extends string ? T : never;
type FullExtract<T> = OnlyStrings<keyof ExtractFromArray<T>>;

type WriteOutConfig<T> = {
  // Fields to output in human-readable format
  fields: readonly FullExtract<T>[];
  // Title of the output
  title?: string;
  // Display message if data is empty
  // does not apply to json and yaml output
  emptyMessage?: string;
  // Custom render functions for specific columns
  renderColumns?: Partial<
    Record<FullExtract<T>, (value: ExtractFromArray<T>) => string>
  >;
};

type Chunk = { data: any; config: WriteOutConfig<any> };

const writeYaml = (chunks: Chunk[]) => {
  return YAML.stringify(
    chunks.length === 1
      ? chunks[0].data
      : Object.fromEntries(
          chunks.map(({ config, data }, idx) => [
            config.title ? toSnakeCase(config.title) : idx,
            data,
          ]),
        ),
    null,
    2,
  );
};

const writeJson = (chunks: Chunk[]) => {
  return JSON.stringify(
    chunks.length === 1
      ? chunks[0].data
      : Object.fromEntries(
          chunks.map(({ config, data }, idx) => [
            config.title ? toSnakeCase(config.title) : idx,
            data,
          ]),
        ),
    null,
    2,
  );
};

const writeTable = (
  chunks: { data: any; config: WriteOutConfig<any> }[],
  out: NodeJS.WritableStream,
) => {
  chunks.forEach(
    ({ data, config: { emptyMessage, fields, title, renderColumns = {} } }) => {
      const arrayData = Array.isArray(data) ? data : [data];
      if (!arrayData.length && emptyMessage) {
        out.write('\n' + emptyMessage + '\n');
        return;
      }

      const fieldsFiltered = fields.filter((field) =>
        arrayData.some(
          (item) => item[field] !== undefined && item[field] !== '',
        ),
      );
      const table = new Table({
        style: {
          head: ['green'],
        },
        head: fieldsFiltered.map((field: string) =>
          field
            .split('_')
            .map((word) => word[0].toUpperCase() + word.slice(1))
            .join(' '),
        ),
      });
      arrayData.forEach((item) => {
        table.push(
          fieldsFiltered.map((field: string | number) => {
            const value = item[field];
            if (renderColumns[field]) {
              return renderColumns[field]?.(item);
            }
            return Array.isArray(value)
              ? value.join('\n')
              : isObject(value)
                ? JSON.stringify(value, null, 2)
                : value;
          }),
        );
      });

      if (title) {
        out.write((isCi() ? title : chalk.bold(title)) + '\n');
      }
      out.write(table.toString());
      out.write('\n');
    },
  );
};

/**
 *
 * Parses the output format, takes data and writes the output to stdout.
 *
 * @example
 * const { data } = await props.apiClient.listProjectBranches(props.project.id);
 * // to output single data
 * writer(props).end(data, { fields: ['id', 'name', 'created_at'] })
 * // to output multiple data
 * writer(props)
 *   .write(data, { fields: ['id', 'name', 'created_at'], title: 'branches' })
 *   .write(data, { fields: ['id', 'created_at'], title: 'endpoints' })
 *   .end()
 */
export const writer = (
  props: Pick<CommonProps, 'output'> & { out?: NodeJS.WritableStream },
) => {
  const out = props.out ?? process.stdout;
  const chunks: { data: any; config: WriteOutConfig<any> }[] = [];

  return {
    write<T>(data: T, config: WriteOutConfig<T>) {
      chunks.push({ data, config });
      return this;
    },
    text(data: string) {
      return out.write(data);
    },
    end: <T>(...args: [T, WriteOutConfig<T>] | []) => {
      if (args.length === 2) {
        chunks.push({ data: args[0], config: args[1] });
      }

      if (props.output == 'yaml') {
        return out.write(writeYaml(chunks));
      }

      if (props.output == 'json') {
        return out.write(writeJson(chunks));
      }

      writeTable(chunks, out);
    },
  };
};
