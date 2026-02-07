let jobCounter = 0;

export default ({
  id: _id,
  action,
  payload = {},
  priorityJob = false,
}) => {
  let id = _id;
  if (typeof id === 'undefined') {
    id = `Job-${jobCounter}-${Math.random().toString(16).slice(3, 8)}`;
    jobCounter += 1;
  }

  return {
    id,
    action,
    payload,
    priorityJob,
  };
};
