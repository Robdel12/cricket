import {
  defineCricketPlugin,
  defineEndpoint,
  defineJob,
  defineModel,
  definePluginSchema,
  defineRule,
  field,
  ok,
  redisQueue,
  z
} from '@robdel12/cricket';

let AdminUser = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string().nullable(),
  state: z.enum(['active', 'suspended'])
});
let AdminUserPage = z.object({
  items: z.array(AdminUser),
  nextCursor: z.string().nullable()
});
let UserActionInput = z.object({
  userId: z.string(),
  action: z.enum(['suspend', 'restore'])
});
let UserActionResult = z.object({
  userId: z.string(),
  action: z.enum(['suspend', 'restore'])
});
let ModerationReport = z.object({
  id: z.string(),
  summary: z.string(),
  state: z.enum(['pending', 'approved', 'rejected'])
});
let ModerationReportPage = z.object({
  items: z.array(ModerationReport),
  nextCursor: z.string().nullable()
});
let ApproveReportResult = z.object({
  reportId: z.string(),
  state: z.literal('approved')
});

export let superAdminSchema = definePluginSchema({
  services: {
    adminAccess: {
      requireAdmin: {
        input: z.unknown(),
        output: z.boolean()
      }
    },
    userSupport: {
      listUsers: {
        input: z.object({
          search: z.string().optional()
        }),
        output: AdminUserPage
      },
      performAction: {
        input: UserActionInput,
        output: UserActionResult
      },
      recordAction: {
        input: UserActionInput,
        output: UserActionResult
      }
    },
    moderation: {
      listReports: {
        input: z.object({
          cursor: z.string().optional()
        }),
        output: ModerationReportPage
      },
      approveReport: {
        input: z.object({ reportId: z.string() }),
        output: ApproveReportResult
      }
    }
  }
});

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

let requireAdmin = defineRule('requireAdmin', async ({ request, services }) => {
  let allowed = await services.adminAccess.requireAdmin(request);

  if (!allowed)
    return forbidden('Admin access required');
});

let listSupportUsers = defineEndpoint({
  method: 'get',
  path: '/admin/support/users',
  query: z.object({
    search: z.string().optional()
  }),
  response: { schema: AdminUserPage },
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
  response: { schema: UserActionResult },
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
  response: { schema: ModerationReportPage },
  beforeBodyRules: [requireAdmin],
  async handler({ input, services }) {
    return ok(await services.moderation.listReports(input.query));
  }
});

let approveModerationReport = defineEndpoint({
  method: 'post',
  path: '/admin/moderation/reports/:reportId/approve',
  params: z.object({ reportId: z.string() }),
  response: { schema: ApproveReportResult },
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
  schema: superAdminSchema,
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
