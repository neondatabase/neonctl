import { BranchScopeProps } from '../types';
import { createPatch } from 'diff';
import { Database } from '@neondatabase/api-client';
import chalk from 'chalk';
import { writer } from '../writer.js';
import { branchIdFromProps } from '../utils/enrichers.js';
import {
  parsePointInTime,
  PointInTime,
  PointInTimeBranchId,
} from '../utils/point_in_time.js';

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
  const pointInTime: PointInTimeBranchId = await parsePointInTime({
    pointInTime: props.compareBranch,
    targetBranchId: baseBranch,
    projectId: props.projectId,
    api: props.apiClient,
  });

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
      pointInTime,
      database,
      props,
    );
    writer(props).text(colorize(patch));
    return;
  }

  baseDatabases.map(async (database) => {
    const patch = await createSchemaDiff(
      baseBranch,
      pointInTime,
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
  pointInTime: PointInTimeBranchId,
  database: Database,
  props: SchemaDiffProps,
) => {
  const baseBranchPoint: PointInTimeBranchId = {
    branchId: baseBranch,
    tag: 'head',
  };
  const [baseSchema, compareSchema] = await Promise.all([
    fetchSchema(baseBranchPoint, database, props),
    fetchSchema(pointInTime, database, props),
  ]);

  return createPatch(
    `Database: ${database.name}`,
    baseSchema,
    compareSchema,
    generateHeader(baseBranchPoint),
    generateHeader(pointInTime),
  );
};

const fetchSchema = async (
  pointInTime: PointInTimeBranchId,
  database: Database,
  props: SchemaDiffProps,
) => {
  return props.apiClient
    .getProjectBranchSchema({
      projectId: props.projectId,
      branchId: pointInTime.branchId,
      db_name: database.name,
      role: database.owner_name,
      ...pointInTimeParams(pointInTime),
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

const pointInTimeParams = (pointInTime: PointInTime) => {
  switch (pointInTime.tag) {
    case 'timestamp':
      return {
        timestamp: pointInTime.timestamp,
      };
    case 'lsn':
      return {
        lsn: pointInTime.lsn ?? undefined,
      };
    default:
      return {};
  }
};

const generateHeader = (pointInTime: PointInTimeBranchId) => {
  const header = `(Branch: ${pointInTime.branchId}`;
  switch (pointInTime.tag) {
    case 'timestamp':
      return `${header} at ${pointInTime.timestamp}`;
    case 'lsn':
      return `${header} at ${pointInTime.lsn}`;
    default:
      return `${header})`;
  }
};

/*
  The command has two positional optional arguments - [base-branch] and [compare-source]
  If only one argument is specified, we should consider it as `compare-source`
    and `base-branch` will be either read from context or the primary branch of project.
*/
export const parseSchemaDiffParams = (props: SchemaDiffProps) => {
  if (!props.compareBranch) {
    if (props.baseBranch) {
      props.compareBranch = props.baseBranch;
      props.baseBranch = props.branch;
    }
  }
  return props;
};
