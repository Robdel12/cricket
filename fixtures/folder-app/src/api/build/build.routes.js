import { z } from 'zod';

import {
  created,
  defineEndpoint,
  notFound,
  ok
} from '../../../../../src/index.js';
import { Build } from './build.model.js';
import {
  BuildPublic,
  serializeBuildPublic
} from './build.serializers.js';
import { isNamedBuild } from './build.rules.js';

export let createBuild = defineEndpoint({
  method: 'post',
  path: '/builds',
  auth: true,
  body: Build.create,
  rules: [isNamedBuild],
  response: z.object({
    success: z.literal(true),
    build: BuildPublic
  }),
  async handler({ input, services, user }) {
    let build = await services.build.createForUser({
      userId: user.id,
      name: input.body.name
    });

    return created({
      success: true,
      build: serializeBuildPublic(build)
    });
  }
});

export let showBuild = defineEndpoint({
  method: 'get',
  path: '/builds/:buildId',
  auth: true,
  params: z.object({
    buildId: z.uuid()
  }),
  responses: {
    200: z.object({
      success: z.literal(true),
      build: BuildPublic
    }),
    404: z.object({
      error: z.object({
        code: z.literal('NOT_FOUND'),
        message: z.string()
      })
    })
  },
  async handler({ input, services }) {
    let build = await services.build.findById(input.params.buildId);

    if (!build)
      throw notFound('Build not found');

    return ok({
      success: true,
      build: serializeBuildPublic(build)
    });
  }
});

export let buildEndpoints = [
  createBuild,
  showBuild
];
