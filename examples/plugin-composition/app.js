import {
  defineCricketApp
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
        requireAdmin(request) {
          return request.headers['x-admin'] === 'true';
        }
      },
      userSupport: {
        async listUsers({ search }) {
          return {
            items: search ? [{
              id: 'user-7',
              email: 'robert@example.com',
              name: 'Robert',
              state: 'active'
            }] : [],
            nextCursor: null
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
