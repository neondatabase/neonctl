import { ComputeUnit } from '@neondatabase/api-client';

type Autoscaling = {
  autoscaling_limit_min_cu?: ComputeUnit;
  autoscaling_limit_max_cu?: ComputeUnit;
};

export const getComputeUnits = (autoscaling: string): Autoscaling => {
  const fixedSizeAutoscaling = Number(autoscaling);
  if (!isNaN(fixedSizeAutoscaling)) {
    return {
      autoscaling_limit_min_cu: fixedSizeAutoscaling,
      autoscaling_limit_max_cu: fixedSizeAutoscaling,
    };
  }
  if (!autoscaling.includes('-')) {
    throw new Error(
      'Autoscaling should be either fixed size (e.g. 2) or min and max sizes delimited with a dash (e.g. "0.5-1")',
    );
  }
  const [min, max] = autoscaling.split('-');
  if (!min || !max) {
    throw new Error(
      'Autoscaling should be either fixed size (e.g. 2) or min and max sizes delimited with a dash (e.g. "0.5-1")',
    );
  }
  const minAutoscaling = Number(min);
  const maxAutoscaling = Number(max);
  if (isNaN(minAutoscaling)) {
    throw new Error('Autoscaling min should be a number');
  }
  if (isNaN(maxAutoscaling)) {
    throw new Error('Autoscaling max should be a number');
  }
  return {
    autoscaling_limit_min_cu: minAutoscaling,
    autoscaling_limit_max_cu: maxAutoscaling,
  };
};
