import { BranchScopeProps } from '../types';
import { createPatch } from 'diff';
import { Database } from '@neondatabase/api-client';
import chalk from 'chalk';
import { writer } from '../writer.js';
import { branchIdFromProps, branchIdResolve } from '../utils/enrichers.js';

type SchemaDiffProps = BranchScopeProps & {
  branch?: string;
  baseBranch?: string;
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
  props.branch = props.baseBranch || props.branch;
  const baseBranch = await branchIdFromProps(props);
  const compareBranch = await branchIdResolve({
    branch: props.compareBranch,
    apiClient: props.apiClient,
    projectId: props.projectId,
  });

  if (baseBranch === compareBranch) {
    throw new Error(
      'Can not compare the branch with itself. Please specify different branch to compare.',
    );
  }

  const baseDatabases = await fetchDatabases(baseBranch, props);

  if (props.database) {
    const database = baseDatabases.find((db) => db.name === props.database);

    if (!database) {
      throw new Error(
        `Database ${props.database} does not exist in base branch ${baseBranch}`,
      );
    }

    const patch = await createSchemaDiff(
      baseBranch,
      compareBranch,
      database,
      props,
    );
    writer(props).text(colorize(patch));
    return;
  }

  baseDatabases.map(async (database) => {
    const patch = await createSchemaDiff(
      baseBranch,
      compareBranch,
      database,
      props,
    );
    writer(props).text(colorize(patch));
  });
};

const fetchDatabases = async (branch: string, props: SchemaDiffProps) => {
  return props.apiClient
    .listProjectBranchDatabases(props.projectId, branch)
    .then((response) => response.data.databases);
};

const createSchemaDiff = async (
  baseBranch: string,
  compareBranch: string,
  database: Database,
  props: SchemaDiffProps,
) => {
  const [baseSchema, compareSchema] = await Promise.all([
    fetchSchema(baseBranch, database, props),
    fetchSchema(compareBranch, database, props),
  ]);

  return createPatch(
    `Database: ${database.name}`,
    baseSchema,
    compareSchema,
    `(Branch: ${baseBranch})`,
    `(Branch: ${compareBranch})`,
  );
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
