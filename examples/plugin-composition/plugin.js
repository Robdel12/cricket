import {
  defineCricketPlugin,
  defineEndpoint,
  defineJob,
  defineModel,
  defineRule,
  field,
  ok,
  redisQueue,
  z
} from '@robdel12/cricket';

let AdminAction = defineModel({
  name: 'AdminAction',
  table: 'admin_action',
  row: {
    id: field.public(z.string()),
    actor_id: field.private(z.string()),
    target_id: field.private(z.string()),
    action: field.public(z.string())
  }
});

let requireAdmin = defineRule('requireAdmin', ({ request, services }) =>
  services.adminAccess.requireAdmin({ request })
);

let listSupportUsers = defineEndpoint({
  method: 'get',
  path: '/admin/support/users',
  query: z.object({
    search: z.string().optional()
  }),
  beforeBodyRules: [requireAdmin],
  async handler({ input, services }) {
    return ok(await services.userSupport.listUsers(input.query));
  }
});

let performUserAction = defineEndpoint({
  method: 'post',
  path: '/admin/support/users/:userId/actions',
  params: z.object({ userId: z.string() }),
  body: z.object({
    action: z.enum(['suspend', 'restore'])
  }),
  beforeBodyRules: [requireAdmin],
  async handler({ input, services }) {
    return ok(await services.userSupport.performAction({
      userId: input.params.userId,
      action: input.body.action
    }));
  }
});

let listModerationReports = defineEndpoint({
  method: 'get',
  path: '/admin/moderation/reports',
  query: z.object({
    cursor: z.string().optional()
  }),
  beforeBodyRules: [requireAdmin],
  async handler({ input, services }) {
    return ok(await services.moderation.listReports(input.query));
  }
});

let approveModerationReport = defineEndpoint({
  method: 'post',
  path: '/admin/moderation/reports/:reportId/approve',
  params: z.object({ reportId: z.string() }),
  beforeBodyRules: [requireAdmin],
  async handler({ input, services }) {
    return ok(await services.moderation.approveReport({
      reportId: input.params.reportId
    }));
  }
});

let recordSupportAction = defineJob({
  name: 'admin.support.record-action',
  input: z.object({
    userId: z.string(),
    action: z.enum(['suspend', 'restore'])
  }),
  result: z.object({
    recorded: z.boolean()
  }),
  queue: redisQueue({ name: 'admin-support' }),
  async run({ input, services }) {
    let action = await services.userSupport.recordAction(input);
    return {
      recorded: action.userId === input.userId && action.action === input.action
    };
  }
});

export let superAdminPlugin = defineCricketPlugin({
  name: 'super-admin',
  domains: [{
    name: 'adminActions',
    models: [AdminAction],
    jobs: [recordSupportAction],
    endpoints: [
      listSupportUsers,
      performUserAction,
      listModerationReports,
      approveModerationReport
    ]
  }]
});
