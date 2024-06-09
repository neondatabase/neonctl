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
import { isAxiosError } from 'axios';
import { sendError } from '../analytics.js';
import { log } from '../log.js';

type SchemaDiffProps = BranchScopeProps & {
  branch?: string;
  baseBranch?: string;
  compareSource: string;
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
  let pointInTime: PointInTimeBranchId = await parsePointInTime({
    pointInTime: props.compareSource,
    targetBranchId: baseBranch,
    projectId: props.projectId,
    api: props.apiClient,
  });

  // Swap base and compare points if comparing with parent branch
  const comparingWithParent = props.compareSource.startsWith('^parent');
  let baseBranchPoint: PointInTimeBranchId = {
    branchId: baseBranch,
    tag: 'head',
  };
  [baseBranchPoint, pointInTime] = comparingWithParent
    ? [pointInTime, baseBranchPoint]
    : [baseBranchPoint, pointInTime];

  const baseDatabases = await fetchDatabases(baseBranch, props);
  if (props.database) {
    const database = baseDatabases.find((db) => db.name === props.database);

    if (!database) {
      throw new Error(
        `Database ${props.database} does not exist in base branch ${baseBranch}`,
      );
    }

    const patch = await createSchemaDiff(
      baseBranchPoint,
      pointInTime,
      database,
      props,
    );
    writer(props).text(colorize(patch));
    return;
  }

  await Promise.all(
    baseDatabases.map(async (database) => {
      const patch = await createSchemaDiff(
        baseBranchPoint,
        pointInTime,
        database,
        props,
      );
      writer(props).text(colorize(patch));
    }),
  );
};

const fetchDatabases = async (branch: string, props: SchemaDiffProps) => {
  return props.apiClient
    .listProjectBranchDatabases(props.projectId, branch)
    .then((response) => response.data.databases);
};

const createSchemaDiff = async (
  baseBranch: PointInTimeBranchId,
  pointInTime: PointInTimeBranchId,
  database: Database,
  props: SchemaDiffProps,
) => {
  const [baseSchema, compareSchema] = await Promise.all([
    fetchSchema(baseBranch, database, props),
    fetchSchema(pointInTime, database, props),
  ]);

  return createPatch(
    `Database: ${database.name}`,
    baseSchema,
    compareSchema,
    generateHeader(baseBranch),
    generateHeader(pointInTime),
  );
};

const fetchSchema = async (
  pointInTime: PointInTimeBranchId,
  database: Database,
  props: SchemaDiffProps,
) => {
  try {
    return props.apiClient
      .getProjectBranchSchema({
        projectId: props.projectId,
        branchId: pointInTime.branchId,
        db_name: database.name,
        role: database.owner_name,
        ...pointInTimeParams(pointInTime),
      })
      .then((response) => response.data.sql ?? '');
  } catch (error) {
    if (isAxiosError(error)) {
      const data = error.response?.data;
      sendError(error, 'API_ERROR');
      throw new Error(
        data.message ??
          `Error while fetching schema for branch ${pointInTime.branchId}`,
      );
    }
    throw error;
  }
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
      return `${header} at ${pointInTime.timestamp})`;
    case 'lsn':
      return `${header} at ${pointInTime.lsn})`;
    default:
      return `${header})`;
  }
};

/*
  The command has two positional optional arguments - [base-branch] and [compare-source]
  If only one argument is specified, we should consider it as `compare-source`
    and `base-branch` will be either read from context or the primary branch of project.
  If no branches are specified, compare the context branch with its parent
*/
export const parseSchemaDiffParams = async (props: SchemaDiffProps) => {
  if (!props.compareSource) {
    if (props.baseBranch) {
      props.compareSource = props.baseBranch;
      props.baseBranch = props.branch;
    } else if (props.branch) {
      const { data } = await props.apiClient.listProjectBranches(
        props.projectId,
      );
      const contextBranch = data.branches.find(
        (b) => b.id === props.branch || b.name === props.branch,
      );

      if (contextBranch?.parent_id == undefined) {
        throw new Error(
          `No branch specified. Your context branch (${props.branch}) has no parent, so no comparison is possible.`,
        );
      }

      log.info(
        `No branches specified. Comparing your context branch '${props.branch}' with its parent`,
      );
      props.compareSource = '^parent';
    } else {
      const { data } = await props.apiClient.listProjectBranches(
        props.projectId,
      );
      const primaryBranch = data.branches.find((b) => b.primary);

      if (primaryBranch?.parent_id == undefined) {
        throw new Error(
          'No branch specified. Include a base branch or add a set-context branch to continue. Your primary branch has no parent, so no comparison is possible.',
        );
      }

      log.info(
        `No branches specified. Comparing primary branch with its parent`,
      );
      props.compareSource = '^parent';
    }
  }
  return props;
};
