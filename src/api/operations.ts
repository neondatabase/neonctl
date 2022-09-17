import { apiCall, BaseApiCallProps } from './gateway';

export type OperationApiCallProps = {
  project_id: string;
  operation_id: string;
};

type Operation = {
  status: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// wait 20 sec max.
export const waitOperationFinalState = async (
  props: BaseApiCallProps & OperationApiCallProps
) => {
  for (let i = 0; i < 100; i++) {
    const operation: Operation = <Operation>await getOperation({ ...props });
    if (operation.status == 'finished') {
      return;
    }
    await sleep(200);
  }
  throw Error(`timeout while waiting for operation ${props.operation_id}`);
};

export const getOperation = (props: BaseApiCallProps & OperationApiCallProps) =>
  apiCall({
    ...props,
    path: `projects/${props.project_id}/operations/${props.operation_id}`,
    method: 'GET',
  });
