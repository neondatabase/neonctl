import { ProjectScopeProps } from '../types';
import { createPatch } from 'diff';
import { Database } from '@neondatabase/api-client';
import chalk from 'chalk';
import { writer } from '../writer.js';

type SchemaDiffProps = ProjectScopeProps & {
  baseBranch: string;
  compareBranch: string;
  database: string;
};

const COLORS = {
  added: chalk.green,
  removed: chalk.red,
  header: chalk.yellow,
  section: chalk.magenta,
};

type ColorId = keyof typeof COLORS;

export const schemaDiff = async (props: SchemaDiffProps) => {
  const baseBranch = props.baseBranch;
  const compareBranch = props.compareBranch;

  const [baseDatabase, compareDatabase] = await Promise.all([
    fetchDatabase(baseBranch, props),
    fetchDatabase(compareBranch, props),
  ]);

  const [baseSchema, compareSchema] = await Promise.all([
    fetchSchema(baseBranch, baseDatabase, props),
    fetchSchema(compareBranch, compareDatabase, props),
  ]);

  const patch = createPatch(
    props.database,
    baseSchema,
    compareSchema,
    `Base Branch: ${baseBranch}`,
    `Compare Branch: ${compareBranch}`,
  );
  writer(props).text(colorize(patch));
};

const fetchDatabase = async (branch: string, props: SchemaDiffProps) => {
  return props.apiClient
    .getProjectBranchDatabase(props.projectId, branch, props.database)
    .then((response) => response.data.database);
};

const fetchSchema = async (
  branch: string,
  database: Database,
  props: SchemaDiffProps,
) => {
  return props.apiClient
    .getProjectBranchSchema({
      projectId: props.projectId,
      branchId: branch,
      db_name: database.name,
      role: database.owner_name,
    })
    .then((response) => response.data.sql ?? '');
};

const colorize = (patch: string) => {
  return patch
    .replace(/^([^\n]+)\n([^\n]+)\n/m, '') // Remove first two lines
    .replace(/^-.*/gm, colorizer('removed'))
    .replace(/^\+.*/gm, colorizer('added'))
    .replace(/^@@.+@@.*/gm, colorizer('section'));
};

const colorizer = (colorId: ColorId) => {
  const color = COLORS[colorId];
  return (line: string) => color(line);
};
