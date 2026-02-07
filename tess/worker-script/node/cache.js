import util from 'util';
import fs from 'fs';

export const readCache = util.promisify(fs.readFile);
export const writeCache = util.promisify(fs.writeFile);
export const deleteCache = (path) => (
  util.promisify(fs.unlink)(path)
    .catch(() => {})
);
