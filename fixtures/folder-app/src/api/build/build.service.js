import { createKnexRepository } from '../../../../../src/index.js';

import {
  Build,
  BuildInsert
} from './build.model.js';

export function createBuildService({ db, ids, logger }) {
  let builds = createKnexRepository({
    db,
    model: Build,
    insert: BuildInsert
  });

  return {
    async createForUser({ userId, name }) {
      let row = await builds.insert({
        id: ids.next(),
        user_id: userId,
        name,
        public: false
      });

      logger.info('build.created', { buildId: row.id });
      return row;
    },

    async findById(id) {
      return await builds.findById(id);
    }
  };
}
