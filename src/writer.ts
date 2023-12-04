import YAML from 'yaml';
import Table from 'cli-table';
import chalk from 'chalk';

import { CommonProps } from './types.js';
import { isCi } from './env.js';
import { toSnakeCase } from './utils/string.js';

type ExtractFromArray<T> = T extends (infer R)[] ? R : T;
type OnlyStrings<T> = T extends string ? T : never;

type WriteOutConfig<T> = {
  // Fields to output in human readable format
  fields: Readonly<OnlyStrings<keyof ExtractFromArray<T>>[]>;
  // Title of the output
  title?: string;
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
    end: <T>(...args: [T, WriteOutConfig<T>] | []) => {
      if (args.length === 2) {
        chunks.push({ data: args[0], config: args[1] });
      }

      if (props.output == 'yaml') {
        out.write(
          YAML.stringify(
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
          ),
        );
        return;
      }

      if (props.output == 'json') {
        out.write(
          JSON.stringify(
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
          ),
        );
        return;
      }

      chunks.forEach(({ data, config }) => {
        const arrayData = Array.isArray(data) ? data : [data];
        const fields = config.fields.filter((field) =>
          arrayData.some(
            (item) => item[field] !== undefined && item[field] !== '',
          ),
        );
        const table = new Table({
          style: {
            head: ['green'],
          },
          head: fields.map((field: string) =>
            field
              .split('_')
              .map((word) => word[0].toUpperCase() + word.slice(1))
              .join(' '),
          ),
        });
        arrayData.forEach((item) => {
          table.push(fields.map((field: string | number) => item[field]));
        });

        if (config.title) {
          out.write((isCi() ? config.title : chalk.bold(config.title)) + '\n');
        }
        out.write(table.toString());
        out.write('\n');
      });
    },
  };
};
