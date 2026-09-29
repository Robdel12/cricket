import {
  defineCricketApp,
  forbidden
} from '@robdel12/cricket';

import { superAdminPlugin } from './plugin.js';

export let app = defineCricketApp({
  name: 'Plugin composition example',
  domains: './domains',
  plugins: [superAdminPlugin],
  services({ services }) {
    return {
      ...services,
      adminAccess: {
        requireAdmin({ request }) {
          if (request.headers['x-admin'] !== 'true')
            return forbidden('Admin access required');
        }
      },
      userSupport: {
        async listUsers({ search }) {
          return {
            data: [],
            search: search ?? null
          };
        },
        async performAction({ userId, action }) {
          return {
            userId,
            action
          };
        },
        async recordAction({ userId, action }) {
          return {
            userId,
            action
          };
        }
      },
      moderation: {
        async listReports({ cursor }) {
          return {
            items: [],
            nextCursor: cursor ?? null
          };
        },
        async approveReport({ reportId }) {
          return {
            reportId,
            state: 'approved'
          };
        }
      }
    };
  }
});
