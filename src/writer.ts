import { CommonProps } from './types.js';
import YAML from 'yaml';
import Table from 'cli-table';
import chalk from 'chalk';

type ExtractFromArray<T> = T extends (infer R)[] ? R : T;
type OnlyStrings<T> = T extends string ? T : never;

// Allow PIPE to finish reading before the end of the output.
process.stdout.on('error', function (err) {
  if (err.code == 'EPIPE') {
    process.exit(0);
  }
});

type WriteOutConfig<T> = {
  // Fields to output in human readable format
  fields: Readonly<OnlyStrings<keyof ExtractFromArray<T>>[]>;
};
type WriteOutFn = (props: CommonProps) => {
  <T>(data: T, config: WriteOutConfig<T>): void;
  <T, K extends string>(
    options: Record<K, { data: T; config: WriteOutConfig<T> }>
  ): void;
};

/**
 *
 * Parses the output format, takes data and writes the output to stdout.
 *
 * @example
 * // to output single data
 * const { data } = await props.apiClient.listProjectBranches(props.project.id);
 * writeOut(props)(data, { fields: ['id', 'name', 'created_at'] })
 * // to output multiple data
 * writeOut(props)({
 *  branches: {
 *   data,
 *  config: { fields: ['id', 'name', 'created_at'] }
 * },
 * endpoints: {
 *  data,
 *  config: { fields: ['id', 'created_at'] }
 * }
 * })
 */
export const writeOut: WriteOutFn =
  (props: CommonProps) => (arg1: any, arg2?: any) => {
    if (props.output == 'yaml') {
      process.stdout.write(
        YAML.stringify(
          arg2 === undefined
            ? Object.fromEntries(
                Object.entries(arg1).map(([k, v]: any) => [k, v.data])
              )
            : arg1,
          null,
          2
        )
      );
      return;
    }
    if (props.output == 'json') {
      process.stdout.write(
        JSON.stringify(
          arg2 === undefined
            ? Object.fromEntries(
                Object.entries(arg1).map(([k, v]: any) => [k, v.data])
              )
            : arg1,
          null,
          2
        )
      );
      return;
    }

    const options =
      arg2 === undefined ? arg1 : { '': { data: arg1, config: arg2 } };
    Object.entries(options).forEach(([key, { data, config }]: any) => {
      const arrayData = Array.isArray(data) ? data : [data];
      const table = new Table({
        style: {
          head: ['green'],
        },
        head: config.fields.map((field: string) =>
          field
            .split('_')
            .map((word) => word[0].toUpperCase() + word.slice(1))
            .join(' ')
        ),
      });
      arrayData.forEach((item) => {
        table.push(
          config.fields.map((field: string | number) => item[field] ?? '')
        );
      });
      process.stdout.write(chalk.bold(key) + '\n');
      process.stdout.write(table.toString());
      process.stdout.write('\n');
    });
  };
