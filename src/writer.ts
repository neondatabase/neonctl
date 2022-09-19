import { CommonProps } from './types';
import YAML from 'yaml';
import Table from 'cli-table';

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
  fields: OnlyStrings<keyof ExtractFromArray<T>>[];
};
export const writeOut =
  (props: CommonProps) =>
  <T>(data: T, config: WriteOutConfig<T>) => {
    if (props.format == 'yaml') {
      process.stdout.write(YAML.stringify(data, null, 2));
      return;
    }
    if (props.format == 'json') {
      process.stdout.write(JSON.stringify(data, null, 2));
      return;
    }
    const arrayData = Array.isArray(data) ? data : [data];
    const table = new Table({
      style: {
        head: ['green'],
      },
      head: config.fields.map((field) =>
        field
          .split('_')
          .map((word) => word[0].toUpperCase() + word.slice(1))
          .join(' ')
      ),
    });
    arrayData.forEach((item) => {
      table.push(config.fields.map((field) => item[field] ?? ''));
    });
    process.stdout.write(table.toString());
    process.stdout.write('\n');
  };
